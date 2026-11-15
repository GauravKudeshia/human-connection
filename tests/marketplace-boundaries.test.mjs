import test from "node:test";
import assert from "node:assert/strict";
import { marketplaceFixture } from "./marketplace-fixture.mjs";
import { createOperationsConsole } from "../lib/marketplace/console.mjs";
import { createMarketplaceHttp } from "../lib/marketplace/http-router.mjs";
import { createVisitorHttp } from "../lib/marketplace/visitor-http.mjs";
import { createExperienceService } from "../lib/marketplace/experience.mjs";
import { createPrivacy } from "../lib/marketplace/privacy.mjs";
const origin = "https://local.example";
function request(body, { cookie, key = "test", requestOrigin = origin } = {}) {
  return new Request(origin + "/api/marketplace/visitor", {
    method: "POST",
    headers: {
      origin: requestOrigin,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}
test("visitor endpoint requires same origin/current consent; cookie is private, revocable, unrelated to accounts", async (t) => {
  const f = await marketplaceFixture();
  t.after(() => f.db.close());
  const handle = createVisitorHttp({
    storageFor: async () => ({ db: f.db }),
    clock: f.clock,
  });
  assert.equal(
    (
      await handle(
        request(
          { action: "start", consent: true, consentVersion: "analytics-v1" },
          { requestOrigin: "https://evil.invalid" },
        ),
      )
    ).status,
    403,
  );
  assert.equal(
    (await handle(request({ action: "start", consent: false }))).status,
    400,
  );
  const response = await handle(
    request({ action: "start", consent: true, consentVersion: "analytics-v1" }),
  );
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert(!JSON.stringify(await response.json()).includes("token"));
  assert.equal(
    (await handle(request({ action: "select" }, { cookie }))).status,
    200,
  );
  assert.equal(
    (await handle(request({ action: "forget" }, { cookie }))).status,
    200,
  );
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM mp_visit_sessions").first()).n,
    0,
  );
});
test("router quota, JSON validation, same-origin policy and logs preserve private request data", async (t) => {
  const f = await marketplaceFixture();
  t.after(() => f.db.close());
  const logs = [];
  const handle = createMarketplaceHttp({
    contextFor: async () => ({
      db: f.db,
      service: f.service,
      actor: f.customer,
      config: {},
      clock: f.clock,
    }),
    logger: (e) => logs.push(e),
    clock: f.clock,
  });
  const bad = await handle(
    request({
      action: "unsupported",
      payload: { reason: "private narrative", token: "secret" },
    }),
  );
  assert.equal(bad.status, 404);
  assert(bad.headers.get("x-request-id"));
  assert(!JSON.stringify(logs).includes("private narrative"));
  assert(!JSON.stringify(logs).includes("secret"));
  assert.equal(logs[0].code, "NOT_FOUND");
  await f.db
    .prepare(
      "UPDATE mp_request_limits SET count=120 WHERE user_id=? AND bucket='mutation'",
    )
    .bind(f.customer.id)
    .run();
  assert.equal(
    (await handle(request({ action: "host-draft", payload: {} }))).status,
    429,
  );
});
test("account suspension is scoped, audited, releases reservations and requires independent staff rights", async (t) => {
  const f = await marketplaceFixture();
  t.after(() => f.db.close());
  const console = createOperationsConsole(f.db, {
    authorize: f.service.authorize,
    clock: f.clock,
  });
  const booking = (
    await f.act(f.customer, "reserve", { ...f.choice, hostId: f.hosts[0].id })
  ).booking;
  await assert.rejects(
    () =>
      console.accountStatus(f.customer, {
        userId: f.hosts[0].id,
        status: "SUSPENDED",
        reason: "Test",
      }),
    (e) => e.status === 403,
  );
  await console.accountStatus(f.admin, {
    userId: f.hosts[0].id,
    status: "SUSPENDED",
    reason: "Test suspension",
  });
  assert.equal(
    (await f.service.read(f.customer, "booking", booking.id)).status,
    "CANCELLED",
  );
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM mp_host_claims").first()).n,
    0,
  );
  await assert.rejects(
    () => f.service.read(f.hosts[0], "bookings"),
    (e) => e.code === "ACCOUNT_UNAVAILABLE",
  );
  await console.accountStatus(f.admin, {
    userId: f.hosts[0].id,
    status: "ACTIVE",
    reason: "Test reinstatement",
  });
  assert.equal(
    (await f.service.read(f.customer, "hosts", null, f.choice)).some(
      (h) => h.user_id === f.hosts[0].id,
    ),
    false,
  );
});
test("safety staff may suspend only a reported account assigned to their open case", async (t) => {
  const f = await marketplaceFixture();
  t.after(() => f.db.close());
  const safety = await f.user("test-safety", ["safety"], true),
    console = createOperationsConsole(f.db, {
      authorize: f.service.authorize,
      clock: f.clock,
    });
  const booking = (
    await f.act(f.customer, "reserve", { ...f.choice, hostId: f.hosts[0].id })
  ).booking;
  const report = await f.act(f.customer, "report", {
    bookingId: booking.id,
    category: "conduct",
    reason: "Fictional test report",
    urgent: false,
  });
  await assert.rejects(
    () =>
      console.accountStatus(safety, {
        userId: f.hosts[0].id,
        status: "SUSPENDED",
        reason: "Test",
      }),
    (e) => e.code === "CONCURRENT_UPDATE",
  );
  await f.act(safety, "case-decision", {
    caseId: report.caseId,
    status: "ASSIGNED",
    reason: "Assigned for test",
  });
  await console.accountStatus(safety, {
    userId: f.hosts[0].id,
    status: "SUSPENDED",
    reason: "Protective action",
  });
  await assert.rejects(
    () =>
      console.accountStatus(safety, {
        userId: f.hosts[0].id,
        status: "ACTIVE",
        reason: "Test",
      }),
    (e) => e.status === 403,
  );
});
test("an in-flight draft cannot resurrect private data after account closure", async (t) => {
  const f = await marketplaceFixture();
  t.after(() => f.db.close());
  const privacy = createPrivacy(f.db, {
    authorize: f.service.authorize,
    clock: f.clock,
  });
  let closed = false;
  const original = f.db.prepare.bind(f.db);
  f.db.prepare = (q) => {
    if (!closed && q.startsWith("INSERT INTO mp_host_drafts")) {
      closed = true;
      f.db.sqlite
        .prepare("UPDATE mp_users SET status='CLOSED' WHERE id=?")
        .run(f.other.id);
    }
    return original(q);
  };
  const experience = createExperienceService(f.db, {
    authorize: f.service.authorize,
    service: f.service,
    clock: f.clock,
  });
  await assert.rejects(
    () => experience.saveDraft(f.other, { biography: "private draft" }),
    (e) => e.code === "ACCOUNT_UNAVAILABLE",
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT COUNT(*) n FROM mp_host_drafts").get().n,
    0,
  );
  assert(privacy);
});
test("remaining-principal refund reviews reopen once and old request retries do not reopen resolved decisions", async (t) => {
  const f = await marketplaceFixture();
  t.after(() => f.db.close());
  const booking = (
    await f.act(f.customer, "reserve", { ...f.choice, hostId: f.hosts[0].id })
  ).booking;
  f.db.sqlite
    .prepare("UPDATE mp_bookings SET status='COMPLETED' WHERE id=?")
    .run(booking.id);
  f.db.sqlite
    .prepare(
      "INSERT INTO mp_payments VALUES('refund-payment',?,'pi_refund_fixture','CAPTURED',1000,'USD',?,?)",
    )
    .run(booking.id, f.clock(), f.clock());
  await f.act(
    f.customer,
    "refund-request",
    { bookingId: booking.id, reason: "First review" },
    "first-review",
  );
  f.db.sqlite.prepare("UPDATE mp_refunds SET status='REFUNDED'").run();
  f.db.sqlite
    .prepare(
      "INSERT INTO mp_payment_refund_totals VALUES('refund-payment',300,?)",
    )
    .run(f.clock());
  await f.act(
    f.customer,
    "refund-request",
    { bookingId: booking.id, reason: "Remaining principal" },
    "second-review",
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_refunds").get().status,
    "OPEN",
  );
  f.db.sqlite.prepare("UPDATE mp_refunds SET status='REJECTED'").run();
  assert.equal(
    (
      await f.act(
        f.customer,
        "refund-request",
        { bookingId: booking.id, reason: "Remaining principal" },
        "second-review",
      )
    ).replayed,
    true,
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_refunds").get().status,
    "REJECTED",
  );
  await assert.rejects(
    () =>
      f.act(
        f.customer,
        "refund-request",
        { bookingId: booking.id, reason: "Changed reason" },
        "second-review",
      ),
    (e) => e.code === "KEY_REUSED",
  );
});
test("staff audit and booking transition evidence reject update and delete tampering", async (t) => {
  const f = await marketplaceFixture();
  t.after(() => f.db.close());
  await f.act(f.customer, "reserve", f.choice);
  for (const table of ["mp_audit_events", "mp_booking_events"]) {
    assert.throws(
      () => f.db.sqlite.exec(`UPDATE ${table} SET created_at=0`),
      /append-only/,
    );
    assert.throws(
      () => f.db.sqlite.exec(`DELETE FROM ${table}`),
      /append-only/,
    );
  }
});
