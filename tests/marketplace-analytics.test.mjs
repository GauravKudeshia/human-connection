import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sqliteD1 } from "./marketplace-db.mjs";
import { createMarketplace } from "../lib/marketplace/store.mjs";
import { createOperations } from "../lib/marketplace/operations.mjs";
const DAY = 86400000,
  start = 1_800_000_000_000;
async function fixture(t) {
  const db = sqliteD1();
  t.after(() => db.close());
  db.sqlite.exec(
    readFileSync(
      new URL("../db/marketplace-analytics.sql", import.meta.url),
      "utf8",
    ),
  );
  let now = start;
  const market = createMarketplace(db, { clock: () => now });
  const user = async (name, roles = []) => {
    const actor = await market.provisionIdentity({
      subject: name,
      displayName: "Fictional " + name,
      stepUp: true,
    });
    for (const role of roles)
      db.sqlite
        .prepare("INSERT OR IGNORE INTO mp_user_roles VALUES(?,?)")
        .run(actor.id, role);
    return actor;
  };
  const customer = await user("customer"),
    host = await user("host", ["host"]),
    admin = await user("admin", ["admin"]);
  const ops = createOperations(db, {
    clock: () => now,
    authorize: market.authorize,
  });
  function booking(
    id,
    {
      customerId = customer.id,
      hostId = host.id,
      at = now,
      status = "COMPLETED",
    } = {},
  ) {
    db.sqlite
      .prepare(
        `INSERT INTO mp_bookings(id,customer_id,host_id,request_key,fingerprint,experience,duration,format,language,quote,amount_cents,currency,status,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,'fixture','laugh',15,'audio','English','{}',1000,'USD',?,?,?,?)`,
      )
      .run(id, customerId, hostId, id, status, at + 900000, at, at);
    return id;
  }
  function capture(id, at = now) {
    const payment = "p_" + id;
    db.sqlite
      .prepare(
        "INSERT INTO mp_payments VALUES(?,?,?,'CAPTURED',1000,'USD',?,?)",
      )
      .run(payment, id, "pi_" + id, at, at);
    for (const [account, debit, credit] of [
      ["processor_clearing", 1000, 0],
      ["service_liability", 0, 1000],
    ])
      db.sqlite
        .prepare("INSERT INTO mp_ledger_entries VALUES(?,?,?,?,?,?,?,?)")
        .run(
          crypto.randomUUID(),
          id,
          payment,
          "capture:" + payment,
          account,
          debit,
          credit,
          at,
        );
  }
  return {
    db,
    market,
    customer,
    host,
    admin,
    ops,
    user,
    booking,
    capture,
    setNow: (value) => {
      now = value;
    },
  };
}

test("optional visitor analytics require explicit consent and store no raw token, account, IP or device identity", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    () =>
      f.ops.startVisitor({ consent: false, consentVersion: "analytics-v1" }),
    (e) => e.code === "CONSENT_REQUIRED",
  );
  await assert.rejects(
    () => f.ops.startVisitor({ consent: true, consentVersion: "outdated" }),
    (e) => e.code === "CONSENT_REQUIRED",
  );
  const visit = await f.ops.startVisitor({
    consent: true,
    consentVersion: "analytics-v1",
  });
  assert.match(visit.token, /^[a-f0-9]{64}$/);
  const replay = await f.ops.startVisitor({
    consent: true,
    consentVersion: "analytics-v1",
    token: visit.token,
  });
  assert.equal(replay.token, visit.token);
  assert.equal(replay.replayed, true);
  await f.ops.recordVisitor(
    visit.token,
    {
      name: "experience_selected",
      accountId: f.customer.id,
      ip: "secret",
      userAgent: "secret",
    },
    "one",
  );
  assert.equal(
    (
      await f.ops.recordVisitor(
        visit.token,
        { name: "experience_selected" },
        "one",
      )
    ).replayed,
    true,
  );
  await assert.rejects(
    () =>
      f.ops.recordVisitor(visit.token, { name: "payment_succeeded" }, "forged"),
    (e) => e.status === 400,
  );
  const stored =
    JSON.stringify(
      f.db.sqlite.prepare("SELECT * FROM mp_visit_sessions").all(),
    ) +
    JSON.stringify(f.db.sqlite.prepare("SELECT * FROM mp_visit_events").all());
  assert.equal(stored.includes(visit.token), false);
  assert.equal(stored.includes(f.customer.id), false);
  assert.equal(stored.includes("secret"), false);
  const report = await f.ops.analytics(f.admin, {
    from: start - 1,
    to: start + 1,
  });
  assert.deepEqual(report.rates.visitorToSelection, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
  assert.equal(report.counts.selections, 0);
  assert.equal(report.visitorCoverage.identityLinked, false);
  await f.ops.forgetVisitor(visit.token);
  assert.equal(
    f.db.sqlite.prepare("SELECT COUNT(*) n FROM mp_visit_events").get().n,
    0,
  );
  await assert.rejects(
    () =>
      f.ops.recordVisitor(
        visit.token,
        { name: "experience_selected" },
        "after-revoke",
      ),
    (e) => e.status === 403,
  );
});

test("visitor sessions expire after 24 hours and are deleted after 31 days with incomplete-window disclosure", async (t) => {
  const f = await fixture(t),
    visit = await f.ops.startVisitor({
      consent: true,
      consentVersion: "analytics-v1",
    });
  f.setNow(start + DAY);
  await assert.rejects(
    () =>
      f.ops.recordVisitor(
        visit.token,
        { name: "experience_selected" },
        "expired",
      ),
    (e) => e.status === 403,
  );
  f.setNow(start + 32 * DAY);
  assert.equal((await f.ops.pruneAnalytics()).visitorSessionsDeleted, 1);
  const result = await f.ops.analytics(f.admin, {
    from: start - 1,
    to: start + 32 * DAY,
  });
  assert.equal(result.visitorCoverage.completeWindow, false);
  assert.deepEqual(result.rates.visitorToSelection, {
    numerator: 0,
    denominator: 0,
    rate: null,
  });
});

test("server matching attempts record failures, idempotency, ownership and accepted-host latency quantiles", async (t) => {
  const f = await fixture(t);
  const other = await f.user("other");
  for (const [i, latency] of [1000, 3000, 9000].entries()) {
    f.setNow(start + i * 10000);
    await f.ops.startMatch(f.customer, "match" + i, "laugh");
    f.booking("matchbooking" + i, { status: "ACCEPTED" });
    await f.ops.finishMatch(f.customer, "match" + i, {
      outcome: "OFFERED",
      bookingId: "matchbooking" + i,
    });
    f.db.sqlite
      .prepare(
        "INSERT INTO mp_booking_events VALUES(?,?,?,'accept','ACCEPTED',?)",
      )
      .run(
        "accept" + i,
        "matchbooking" + i,
        f.host.id,
        start + i * 10000 + latency,
      );
  }
  await f.ops.startMatch(f.customer, "no-match", "laugh");
  await f.ops.finishMatch(f.customer, "no-match", { outcome: "NO_MATCH" });
  await f.ops.startMatch(f.customer, "pending", "laugh");
  await assert.rejects(
    () => f.ops.startMatch(f.customer, "no-match", "hear"),
    (e) => e.code === "KEY_REUSED",
  );
  await assert.rejects(
    () =>
      f.ops.finishMatch(other, "pending", {
        outcome: "OFFERED",
        bookingId: "matchbooking0",
      }),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () =>
      f.ops.finishMatch(f.customer, "pending", {
        outcome: "OFFERED",
        bookingId: "foreign",
      }),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () =>
      f.ops.finishMatch(f.customer, "no-match", {
        outcome: "OFFERED",
        bookingId: "matchbooking0",
      }),
    (e) => e.code === "KEY_REUSED",
  );
  f.setNow(start + 60000);
  const result = await f.ops.analytics(f.admin, {
    from: start - 1,
    to: start + 60000,
  });
  assert.equal(result.matching.attempts, 5);
  assert.equal(result.matching.offered, 3);
  assert.equal(result.matching.pending, 1);
  assert.equal(result.matching.noMatch, 1);
  assert.equal(result.matching.medianMs, 3000);
  assert.equal(result.matching.p95Ms, 9000);
  assert.deepEqual(result.rates.matchSuccess, {
    numerator: 3,
    denominator: 5,
    rate: 0.6,
  });
});

test("repeat-purchase cohorts exclude immature customers and derive rebooking from captured purchases", async (t) => {
  const f = await fixture(t),
    second = await f.user("second"),
    immature = await f.user("immature");
  const purchases = [
    ["first", f.customer.id, start],
    ["repeat7", f.customer.id, start + 3 * DAY],
    ["repeat30", f.customer.id, start + 12 * DAY],
    ["second-first", second.id, start + 2 * DAY],
    ["immature-first", immature.id, start + 38 * DAY],
  ];
  for (const [id, customerId, at] of purchases) {
    f.booking(id, { customerId, at });
    f.capture(id, at);
  }
  // A pending payment is not a purchase and cannot become a repeat-purchase numerator.
  f.booking("not-paid", {
    customerId: second.id,
    at: start + 5 * DAY,
    status: "ACCEPTED",
  });
  f.db.sqlite
    .prepare(
      "INSERT INTO mp_payments VALUES('pending','not-paid','pi_pending','PENDING',1000,'USD',?,?)",
    )
    .run(start + 5 * DAY, start + 5 * DAY);
  f.setNow(start + 40 * DAY);
  const result = await f.ops.analytics(f.admin, {
    from: start - 1,
    to: start + 40 * DAY,
  });
  assert.deepEqual(result.retention.days7, {
    numerator: 1,
    denominator: 2,
    rate: 0.5,
    cohortCustomers: 3,
    immatureCustomers: 1,
    horizonDays: 7,
  });
  assert.deepEqual(result.retention.days30, {
    numerator: 1,
    denominator: 2,
    rate: 0.5,
    cohortCustomers: 3,
    immatureCustomers: 1,
    horizonDays: 30,
  });
  assert.deepEqual(result.rates.rebooking, {
    numerator: 2,
    denominator: 5,
    rate: 0.4,
  });
  assert.equal(result.financial.grossMerchandiseValueCents, 5000);
});

test("host utilization uses heartbeat-bounded availability and unioned dual attendance, with unmeasured time explicit", async (t) => {
  const f = await fixture(t);
  for (const [delta, available] of [
    [0, 1],
    [30000, 1],
    [50000, 0],
    [60000, 1],
  ])
    f.db.sqlite
      .prepare(
        "INSERT INTO mp_host_presence VALUES(?,?,?) ON CONFLICT(host_id) DO UPDATE SET available=excluded.available,last_seen_at=excluded.last_seen_at",
      )
      .run(f.host.id, available, start + delta);
  f.booking("live", { status: "LIVE" });
  f.db.sqlite
    .prepare(
      "INSERT INTO mp_session_timing(booking_id,started_at) VALUES('live',?)",
    )
    .run(start + 10000);
  for (const [session, user, joined, left] of [
    ["host", f.host.id, 5000, 80000],
    ["host-second", f.host.id, 6000, 81000],
    ["customer", f.customer.id, 10000, 70000],
  ])
    f.db.sqlite
      .prepare("INSERT INTO mp_session_presence VALUES('live',?,?,?,?)")
      .run(session, user, start + joined, start + left);
  f.setNow(start + 200000);
  const result = await f.ops.analytics(f.admin, {
    from: start,
    to: start + 200000,
  });
  assert.equal(result.hostUtilization.availableMs, 140000);
  assert.equal(result.hostUtilization.busyMs, 50000);
  assert.equal(result.hostUtilization.unobservedBusyMs, 10000);
  assert.equal(result.hostUtilization.rate, 50000 / 140000);
  assert.equal(result.hostUtilization.observedHosts, 1);
});

test("financial outcome metrics and denominators cannot be fabricated by client analytics events", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "payment_succeeded",
    "checkout_started",
    "host_accepted",
    "session_completed",
  ])
    await assert.rejects(
      () => f.ops.record(f.customer, { name }, name),
      (e) => e.status === 400,
    );
  await assert.rejects(
    () => f.ops.analytics(f.customer),
    (e) => e.status === 403,
  );
  const noMfa = await f.market.provisionIdentity({
    subject: "admin",
    displayName: "Fictional admin",
    stepUp: false,
  });
  await assert.rejects(
    () => f.ops.analytics(noMfa),
    (e) => e.code === "STEP_UP_REQUIRED",
  );
  const result = await f.ops.analytics(f.admin, {
    from: start - 1,
    to: start + 1,
  });
  assert.equal(result.rates.paidToSessionStart.rate, null);
  assert.equal(result.hostUtilization.rate, null);
  assert.equal(result.matching.p95Ms, null);
  assert.equal(result.financial.deliveredContribution.centsPerSession, null);
});

test("any settled partial refund contributes once to refund incidence while principal stays itemized", async (t) => {
  const f = await fixture(t);
  f.booking("partially-refunded");
  f.capture("partially-refunded");
  f.db.sqlite
    .prepare(
      "INSERT INTO mp_ledger_entries VALUES('refund-entry','partially-refunded','p_partially-refunded','refund:p_partially-refunded:400','processor_clearing',0,400,?)",
    )
    .run(start);
  const result = await f.ops.analytics(f.admin, {
    from: start - 1,
    to: start + 1,
  });
  assert.deepEqual(result.rates.refunds, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
  assert.equal(result.financial.customerNetCents, 600);
  assert.equal(result.financial.refundPrincipalCents, 400);
  assert.equal(result.financial.grossMerchandiseValueCents, 1000);
});

test("host quality is scoped to its authenticated host and excludes private guest feedback", async (t) => {
  const f = await fixture(t),
    otherHost = await f.user("other-host", ["host"]);
  f.booking("own");
  f.booking("other", { hostId: otherHost.id });
  for (const [id, rating] of [
    ["own", 4],
    ["other", 1],
  ])
    f.db.sqlite
      .prepare(
        "INSERT INTO mp_reviews VALUES(?,?,?,1,'private guest detail',?)",
      )
      .run(id, f.customer.id, rating, start);
  const result = await f.ops.hostQuality(f.host, {
    from: start - 1,
    to: start + 1,
  });
  assert.equal(result.counts.completed, 1);
  assert.deepEqual(result.ratings, { average: 4, denominator: 1 });
  assert.equal(JSON.stringify(result).includes("private guest detail"), false);
  await assert.rejects(
    () => f.ops.hostQuality(f.customer),
    (e) => e.status === 403,
  );
});
