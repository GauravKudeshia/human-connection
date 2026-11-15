import test from "node:test";
import assert from "node:assert/strict";
import { sqliteD1 } from "./marketplace-db.mjs";
import { createMarketplace } from "../lib/marketplace/store.mjs";

const start = 1_800_000_000_000;
const choice = {
  experience: "laugh",
  duration: 15,
  format: "video",
  language: "English",
  style: "funny-stories",
};
async function fixture() {
  const db = sqliteD1();
  let now = start;
  const service = createMarketplace(db, { clock: () => now });
  const user = async (subject, stepUp = false) => {
    const actor = await service.provisionIdentity({
      subject,
      displayName: subject,
      stepUp,
    });
    await db
      .prepare(
        "INSERT OR IGNORE INTO mp_customer_eligibility VALUES(?,1,1,'beta-2026-11',?)",
      )
      .bind(actor.id, now)
      .run();
    return actor;
  };
  const customer = await user("customer");
  const stranger = await user("stranger");
  const host = await user("host");
  const reviewer = await user("reviewer", true);
  const safety = await user("safety", true);
  const finance = await user("finance", true);
  for (const [actor, role] of [
    [reviewer, "host_reviewer"],
    [safety, "safety"],
    [finance, "finance"],
  ])
    await db
      .prepare("INSERT INTO mp_user_roles VALUES(?,?)")
      .bind(actor.id, role)
      .run();
  const act = (actor, action, payload = {}, key = crypto.randomUUID()) =>
    service.act(actor, action, payload, key);
  const application = {
    displayName: "Fictional host fixture",
    biography: "Test-only performer",
    languages: ["English"],
    formats: ["video"],
    styles: ["funny-stories"],
    adult: true,
    policyVersion: "beta-2026-11",
    trainingVersion: "beta-2026-11",
  };
  await act(host, "host-submit", application);
  // External verification completion is deliberately unavailable through public actions.
  await db
    .prepare(
      "INSERT INTO mp_host_verifications VALUES(?,'VERIFIED','fixture-provider',1,'US','ELIGIBLE',?)",
    )
    .bind(host.id, now)
    .run();
  await act(reviewer, "host-review", {
    hostId: host.id,
    status: "APPROVED",
    reason: "Fixture reviewed",
  });
  await act(reviewer, "certify", {
    hostId: host.id,
    experience: "laugh",
    status: "APPROVED",
    rubric: "Test-only audition rubric",
    expiresAt: now + 86400000,
  });
  await act(host, "heartbeat", { available: true });
  const reserve = (actor = customer, key = crypto.randomUUID()) =>
    act(actor, "reserve", { ...choice, hostId: host.id }, key);
  return {
    db,
    service,
    user,
    customer,
    stranger,
    host,
    reviewer,
    safety,
    finance,
    act,
    reserve,
    setNow: (value) => {
      now = value;
    },
  };
}

test("32 independent customers share one atomic host claim and only the winner produces booking evidence", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const customers = await Promise.all(
    Array.from({ length: 32 }, (_, i) => f.user("customer-" + i)),
  );
  const results = await Promise.allSettled(
    customers.map((actor) => f.reserve(actor)),
  );
  assert.equal(
    results.filter((entry) => entry.status === "fulfilled").length,
    1,
  );
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM mp_bookings").first()).n,
    1,
  );
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM mp_host_claims").first()).n,
    1,
  );
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM mp_booking_events").first()).n,
    1,
  );
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM mp_notifications").first()).n,
    1,
  );
});
test("reservation retries preserve a single booking and reject changed choices without charges", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const first = await f.reserve(f.customer, "same-request");
  const again = await f.reserve(f.customer, "same-request");
  assert.equal(first.booking.id, again.booking.id);
  assert.equal(again.replayed, true);
  await assert.rejects(
    () =>
      f.act(
        f.customer,
        "reserve",
        { ...choice, duration: 30, hostId: f.host.id },
        "same-request",
      ),
    (error) => error.code === "KEY_REUSED",
  );
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM mp_payments").first()).n,
    0,
  );
});
test("host approval requires verification, certification is experience specific, and stale presence is excluded", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  assert.equal(
    (await f.service.read(f.customer, "hosts", null, choice)).length,
    1,
  );
  assert.equal(
    (
      await f.service.read(f.customer, "hosts", null, {
        ...choice,
        experience: "hear",
        style: null,
      })
    ).length,
    0,
  );
  f.setNow(start + 45001);
  assert.equal(
    (await f.service.read(f.customer, "hosts", null, choice)).length,
    0,
  );
  await f.db.prepare("UPDATE mp_host_verifications SET status='PENDING'").run();
  await assert.rejects(
    () =>
      f.act(f.reviewer, "host-review", {
        hostId: f.host.id,
        status: "APPROVED",
        reason: "Cannot approve",
      }),
    (error) => error.code === "VERIFICATION_REQUIRED",
  );
});
test("only the requested host can accept and approval is rechecked during acceptance", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const { booking } = await f.reserve();
  await assert.rejects(
    () => f.act(f.stranger, "accept", { bookingId: booking.id }),
    (error) => error.status === 404,
  );
  await assert.rejects(
    () => f.act(f.customer, "accept", { bookingId: booking.id }),
    (error) => error.status === 403,
  );
  await f.db.prepare("UPDATE mp_certifications SET status='REVOKED'").run();
  await assert.rejects(
    () => f.act(f.host, "accept", { bookingId: booking.id }),
    (error) => error.code === "CONCURRENT_UPDATE",
  );
  assert.equal(
    (await f.service.read(f.customer, "booking", booking.id)).status,
    "REQUESTED",
  );
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM mp_booking_events").first()).n,
    1,
  );
  await f.db.prepare("UPDATE mp_certifications SET status='APPROVED'").run();
  const accepted = await f.act(f.host, "accept", { bookingId: booking.id });
  assert.equal(JSON.parse(accepted.booking.quote).style, "funny-stories");
  assert.equal(accepted.booking.expires_at, start + 180000);
});
test("expiry releases the global host and queues captured late payments for review", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const { booking } = await f.reserve();
  await f.act(f.host, "accept", { bookingId: booking.id });
  await f.db
    .prepare(
      "INSERT INTO mp_payments VALUES('payment',?,'pi_fixture','CAPTURED',1000,'USD',?,?)",
    )
    .bind(booking.id, start, start)
    .run();
  f.setNow(start + 180000);
  await f.service.expire();
  await f.service.expire();
  assert.equal(
    (await f.service.read(f.customer, "booking", booking.id)).status,
    "EXPIRED",
  );
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM mp_host_claims").first()).n,
    0,
  );
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM mp_refunds").first()).n,
    1,
  );
  assert.equal(
    (
      await f.db
        .prepare(
          "SELECT COUNT(*) n FROM mp_booking_events WHERE action='expired'",
        )
        .first()
    ).n,
    1,
  );
});
test("customer booking privacy and separate step-up safety and finance permissions are enforced by the service", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const { booking } = await f.reserve();
  await assert.rejects(
    () => f.service.read(f.stranger, "booking", booking.id),
    (error) => error.status === 404,
  );
  await assert.rejects(
    () => f.service.read(f.customer, "safety"),
    (error) => error.status === 403,
  );
  await assert.rejects(
    () => f.service.read(f.finance, "safety"),
    (error) => error.status === 403,
  );
  await assert.rejects(
    () => f.service.read(f.safety, "refunds"),
    (error) => error.status === 403,
  );
  const noStepUp = await f.user("safety", false);
  await assert.rejects(
    () => f.service.read(noStepUp, "safety"),
    (error) => error.code === "STEP_UP_REQUIRED",
  );
  await assert.rejects(
    () => f.service.read({ id: f.customer.id }, "bookings"),
    (error) => error.status === 401,
  );
  await f.db
    .prepare("UPDATE mp_users SET status='SUSPENDED' WHERE id=?")
    .bind(f.customer.id)
    .run();
  await assert.rejects(
    () => f.service.read(f.customer, "bookings"),
    (error) => error.status === 403,
  );
});
test("urgent reports are private, retry once and end a session without a refund success claim", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const { booking } = await f.reserve();
  const payload = {
    bookingId: booking.id,
    category: "conduct",
    urgent: true,
    reason: "Fictional concern",
  };
  const result = await f.act(f.customer, "report", payload, "report-once");
  const repeated = await f.act(f.customer, "report", payload, "report-once");
  assert.equal(result.caseId, repeated.caseId);
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM mp_safety_reports").first()).n,
    1,
  );
  assert.equal(
    (await f.service.read(f.customer, "booking", booking.id)).status,
    "SAFETY_ENDED",
  );
  const queue = await f.service.read(f.safety, "safety");
  assert.equal(queue[0].narrative, payload.reason);
  await f.act(f.safety, "case-decision", {
    caseId: result.caseId,
    status: "CLOSED",
    reason: "Reviewed",
  });
  await assert.rejects(
    () =>
      f.act(f.safety, "case-decision", {
        caseId: result.caseId,
        status: "ASSIGNED",
        reason: "Late decision",
      }),
    (error) => error.code === "INVALID_STATE",
  );
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM mp_case_events").first()).n,
    1,
  );
});
test("shared activities persist revisions across participants and reject outsiders or incompatible activities", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const { booking } = await f.reserve();
  // Actual provider delivery remains unconfigured. This database fixture models an already active room.
  await f.db
    .prepare("UPDATE mp_bookings SET status='LIVE',expires_at=? WHERE id=?")
    .bind(start + 900000, booking.id)
    .run();
  const first = await f.act(f.customer, "activity", {
    bookingId: booking.id,
    revision: 0,
    operation: "select",
    activityId: "laugh-story",
  });
  assert.equal(first.activity.revision, 1);
  assert.equal(
    (await f.service.read(f.host, "activity", booking.id)).activity_id,
    "laugh-story",
  );
  await assert.rejects(
    () =>
      f.act(f.stranger, "activity", {
        bookingId: booking.id,
        revision: 1,
        operation: "clear",
      }),
    (error) => error.status === 404,
  );
  await assert.rejects(
    () =>
      f.act(f.host, "activity", {
        bookingId: booking.id,
        revision: 0,
        operation: "clear",
      }),
    (error) => error.code === "STALE_REVISION",
  );
  await assert.rejects(
    () =>
      f.act(f.host, "activity", {
        bookingId: booking.id,
        revision: 1,
        operation: "select",
        activityId: "hear-day",
      }),
    (error) => error.status === 400,
  );
  const second = await f.act(f.host, "activity", {
    bookingId: booking.id,
    revision: 1,
    operation: "advance",
  });
  assert.equal(second.activity.prompt_index, 1);
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM mp_activity_events").first()).n,
    2,
  );
});
test("host decline releases a request before payment and bilateral blocks exclude rebooking", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const { booking } = await f.reserve();
  await f.act(f.host, "decline", { bookingId: booking.id });
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM mp_host_claims").first()).n,
    0,
  );
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM mp_payments").first()).n,
    0,
  );
  await f.act(f.host, "block", { userId: f.customer.id });
  await assert.rejects(
    () => f.reserve(),
    (error) => error.code === "NO_MATCH",
  );
});
