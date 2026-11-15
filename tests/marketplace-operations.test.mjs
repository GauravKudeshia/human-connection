import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sqliteD1 } from "./marketplace-db.mjs";
import { createMarketplace } from "../lib/marketplace/store.mjs";
import { createOperations } from "../lib/marketplace/operations.mjs";
const start = 1_800_000_000_000;
async function fixture() {
  const db = sqliteD1();
  db.sqlite.exec(
    readFileSync(
      new URL("../db/marketplace-operations.sql", import.meta.url),
      "utf8",
    ),
  );
  db.sqlite.exec(
    readFileSync(
      new URL("../db/marketplace-analytics.sql", import.meta.url),
      "utf8",
    ),
  );
  let now = start;
  const market = createMarketplace(db, { clock: () => now });
  const customer = await market.provisionIdentity({
    subject: "customer",
    displayName: "Fictional customer",
    stepUp: true,
  });
  const admin = await market.provisionIdentity({
    subject: "admin",
    displayName: "Fictional admin",
    stepUp: true,
  });
  const safety = await market.provisionIdentity({
    subject: "safety",
    displayName: "Fictional safety",
    stepUp: true,
  });
  await db
    .prepare("INSERT INTO mp_user_roles VALUES(?,'admin')")
    .bind(admin.id)
    .run();
  await db
    .prepare("INSERT INTO mp_user_roles VALUES(?,'safety')")
    .bind(safety.id)
    .run();
  const create = (notificationProvider) =>
    createOperations(db, {
      clock: () => now,
      authorize: market.authorize,
      notificationProvider,
    });
  const notification = (id = "notice") =>
    db
      .prepare(
        "INSERT INTO mp_notifications(id,user_id,kind,available_at,created_at) VALUES(?,?,'host_request',?,?)",
      )
      .bind(id, customer.id, now, now)
      .run();
  return {
    db,
    market,
    customer,
    admin,
    safety,
    create,
    notification,
    setNow: (time) => {
      now = time;
    },
  };
}
test("product events persist only allowlisted fields with idempotent account-scoped keys", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const ops = f.create();
  const event = {
    name: "experience_selected",
    experience: "laugh",
    privateFeedback: "do not persist this",
  };
  const result = await ops.record(f.customer, event, "event");
  assert.equal(
    (await ops.record(f.customer, event, "event")).eventId,
    result.eventId,
  );
  await assert.rejects(
    () => ops.record(f.customer, { name: "payment_succeeded" }, "payment"),
    (e) => e.status === 400,
  );
  await assert.rejects(
    () =>
      ops.record(
        f.customer,
        { name: "experience_selected", experience: "hear" },
        "event",
      ),
    (e) => e.code === "KEY_REUSED",
  );
  assert.equal(
    JSON.stringify(
      f.db.sqlite.prepare("SELECT * FROM mp_analytics_events").get(),
    ).includes("do not persist"),
    false,
  );
});
test("analytics are admin/MFA restricted, use explicit empty denominators and separate selection events", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const ops = f.create();
  await assert.rejects(
    () => ops.analytics(f.customer),
    (e) => e.status === 403,
  );
  await assert.rejects(
    () => ops.analytics(f.safety),
    (e) => e.status === 403,
  );
  await ops.record(
    f.customer,
    { name: "experience_selected", experience: "laugh" },
    "selection",
  );
  const result = await ops.analytics(f.admin, {
    from: start - 1,
    to: start + 1,
  });
  assert.equal(result.counts.selections, 1);
  assert.equal(result.counts.requested, 0);
  assert.deepEqual(result.rates.worthIt, {
    numerator: 0,
    denominator: 0,
    rate: null,
  });
  assert.equal(result.financial.contributionCents, 0);
  await assert.rejects(
    () => ops.analytics(f.admin, { from: start, to: start - 1 }),
    (e) => e.status === 400,
  );
});
test("notification leases prevent duplicate sends from concurrent workers and retain a stable delivery key", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.notification();
  const sent = [];
  let release;
  const provider = {
    async send(message) {
      sent.push(message);
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const first = f.create(provider).dispatch();
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  const second = await f.create(provider).dispatch();
  assert.equal(second.processed, 0);
  release();
  await first;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].idempotencyKey, "notice");
  assert.deepEqual(Object.keys(sent[0]).sort(), [
    "bookingId",
    "idempotencyKey",
    "kind",
    "recipientId",
  ]);
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_notifications").get().status,
    "DELIVERED",
  );
  assert.equal((await f.create(provider).dispatch()).processed, 0);
});
test("failed notifications use bounded backoff, stop after five tries, and create an operator alert", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.notification();
  let sends = 0;
  const ops = f.create({
    async send() {
      sends++;
      throw new Error("Private provider text");
    },
  });
  for (let i = 0; i < 5; i++) {
    await ops.dispatch();
    const row = f.db.sqlite
      .prepare("SELECT available_at FROM mp_notifications")
      .get();
    f.setNow(row.available_at);
  }
  assert.equal(sends, 5);
  assert.equal((await ops.dispatch()).processed, 1); // The new staff alert is a separate bounded outbox delivery.
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_notifications").get().status,
    "FAILED",
  );
  assert.equal((await ops.alerts(f.safety)).length, 0);
  assert.equal((await ops.alerts(f.admin)).length, 1);
  assert.equal(
    JSON.stringify(await ops.alerts(f.safety)).includes(
      "Private provider text",
    ),
    false,
  );
});
test("unconfigured delivery leaves pending notifications unchanged", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.notification();
  assert.equal((await f.create().dispatch()).configured, false);
  const row = f.db.sqlite
    .prepare("SELECT status,attempts FROM mp_notifications")
    .get();
  assert.equal(row.status, "PENDING");
  assert.equal(row.attempts, 0);
});

test("financial metrics separate host principal, platform revenue and actual processing expense", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  f.db.sqlite
    .prepare(
      "INSERT INTO mp_bookings(id,customer_id,host_id,request_key,fingerprint,experience,duration,format,language,quote,amount_cents,currency,status,expires_at,created_at,updated_at) VALUES('booking',?,?,'request','hash','laugh',15,'audio','English','{}',1000,'USD','COMPLETED',?,?,?)",
    )
    .run(f.customer.id, f.admin.id, start + 1000, start, start);
  f.db.sqlite
    .prepare(
      "INSERT INTO mp_payments VALUES('payment','booking','pi_fixture','CAPTURED',1000,'USD',?,?)",
    )
    .run(start, start);
  const entries = [
    ["capture:payment", "processor_clearing", 1000, 0],
    ["capture:payment", "service_liability", 0, 1000],
    ["delivery:payment", "service_liability", 1000, 0],
    ["delivery:payment", "host_base_payable", 0, 700],
    ["delivery:payment", "platform_revenue", 0, 300],
    ["fee:payment", "processing_fee_expense", 30, 0],
    ["fee:payment", "processor_clearing", 0, 30],
  ];
  for (const [event, account, debit, credit] of entries)
    f.db.sqlite
      .prepare(
        "INSERT INTO mp_ledger_entries VALUES(?,'booking','payment',?,?,?,?,?)",
      )
      .run(crypto.randomUUID(), event, account, debit, credit, start);
  const result = await f
    .create()
    .analytics(f.admin, { from: start - 1, to: start + 1 });
  assert.equal(result.counts.completed, 1);
  assert.equal(result.financial.customerNetCents, 1000);
  assert.equal(result.financial.platformRevenueCents, 300);
  assert.equal(result.financial.processingFeesCents, 30);
  assert.equal(result.financial.contributionCents, 270);
  assert.equal(result.financial.grossMerchandiseValueCents, 1000);
  assert.deepEqual(result.financial.deliveredContribution, {
    totalCents: 270,
    denominator: 1,
    centsPerSession: 270,
  });
});

test("operational alerts remain least-privileged and failed staff delivery cannot create an alert loop", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const ops = f.create({
    async send() {
      throw Error("Private failure");
    },
  });
  await ops.noteFailure("payment_mismatch", "server-only-reference");
  assert.equal((await ops.alerts(f.safety)).length, 0);
  assert.equal((await ops.alerts(f.admin)).length, 1);
  for (let i = 0; i < 7; i++) {
    await ops.dispatch();
    f.setNow(start + (i + 1) * 3600000);
  }
  assert.equal(
    f.db.sqlite.prepare("SELECT COUNT(*) n FROM mp_operator_alerts").get().n,
    1,
  );
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT COUNT(*) n FROM mp_notifications WHERE kind='operations_alert'",
      )
      .get().n,
    1,
  );
  await assert.rejects(
    () => ops.noteFailure("private_report_body", "not-stored"),
    (e) => e.code === "VALIDATION",
  );
});
