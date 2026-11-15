import test from "node:test";
import assert from "node:assert/strict";
import { quoteFor, allocationFor } from "../lib/marketplace/pricing.mjs";
import {
  createStripeSandbox,
  verifyStripeWebhook,
  createDailyTestProvider,
} from "../lib/marketplace/providers.mjs";
import { createPaymentService } from "../lib/marketplace/finance.mjs";
import { sqliteD1 } from "./marketplace-db.mjs";

const now = 1_800_000_000_000;
const choice = {
  experience: "laugh",
  style: "playful-banter",
  duration: 15,
  format: "video",
  language: "English",
  now,
};
function fixture() {
  const db = sqliteD1();
  for (const id of ["customer", "host", "outsider"])
    db.sqlite
      .prepare(
        "INSERT INTO mp_users(id,provider_subject,display_name,created_at) VALUES(?,?,?,?)",
      )
      .run(id, id, id, now);
  db.sqlite
    .prepare(
      "INSERT INTO mp_user_roles(user_id,role) VALUES('customer','customer')",
    )
    .run();
  const quote = quoteFor(choice);
  db.sqlite
    .prepare(
      "INSERT INTO mp_bookings(id,customer_id,host_id,request_key,fingerprint,experience,duration,format,language,quote,amount_cents,currency,status,expires_at,created_at,updated_at) VALUES('booking','customer','host','request','digest','laugh',15,'video','English',?,1000,'USD','ACCEPTED',?,?,?)",
    )
    .run(JSON.stringify(quote), now + 180000, now, now);
  db.sqlite
    .prepare(
      "INSERT INTO mp_host_claims(host_id,customer_id,booking_id,expires_at) VALUES('host','customer','booking',?)",
    )
    .run(now + 180000);
  const calls = [];
  const provider = createStripeSandbox({
    secretKey: "sk_test_fixture",
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        id: "pi_fixture",
        livemode: false,
        amount: 1000,
        currency: "usd",
        client_secret: "test_client_secret",
      });
    },
  });
  return {
    db,
    calls,
    service: createPaymentService(db, { provider, clock: () => now }),
  };
}
const success = (id = "evt_success") => ({
  id,
  type: "payment_intent.succeeded",
  livemode: false,
  data: {
    object: {
      id: "pi_fixture",
      amount: 1000,
      amount_received: 1000,
      currency: "usd",
    },
  },
});
const refund = () => ({
  id: "evt_refund",
  type: "charge.refunded",
  livemode: false,
  data: {
    object: {
      id: "ch_fixture",
      payment_intent: "pi_fixture",
      amount: 1000,
      amount_refunded: 1000,
      refunded: true,
      currency: "usd",
    },
  },
});

test("quotes ignore client totals and preserve a versioned server policy", () => {
  const q = quoteFor({ ...choice, totalCents: 1, hostShareBasisPoints: 0 });
  assert.equal(q.totalCents, 1000);
  assert.equal(q.hostShareBasisPoints, 7000);
  assert.equal(q.expiresAt, now + 180000);
  assert.equal(Object.isFrozen(q), true);
  const custom = quoteFor(choice, {
    version: "experiment",
    currency: "USD",
    prices: { 15: 1200, 30: 2000 },
    hostShareBasisPoints: 7500,
    quoteTtlMs: 60000,
  });
  assert.equal(custom.totalCents, 1200);
  assert.deepEqual(allocationFor(1001), { hostCents: 701, platformCents: 300 });
  assert.equal(
    allocationFor(Number.MAX_SAFE_INTEGER, 9999).hostCents,
    9006298534815517,
  );
  assert.throws(() => quoteFor({ ...choice, duration: 1 }));
});
test("payment provider enforces sandbox credentials and rejects live responses", async () => {
  assert.throws(() => createStripeSandbox({ secretKey: "sk_live_fixture" }));
  const provider = createStripeSandbox({
    secretKey: "sk_test_fixture",
    fetcher: async () => Response.json({ livemode: true }),
  });
  await assert.rejects(
    () =>
      provider.createIntent({ bookingId: "b", quote: quoteFor(choice) }, "key"),
    /live object/,
  );
});
test("checkout is owner-scoped and duplicate calls use a stable provider idempotency key", async () => {
  const { db, service, calls } = fixture();
  await assert.rejects(() => service.checkout({ id: "outsider" }, "booking"));
  await Promise.all(
    Array.from({ length: 12 }, () =>
      service.checkout({ id: "customer" }, "booking"),
    ),
  );
  assert.equal(
    db.sqlite.prepare("SELECT count(*) AS n FROM mp_payments").get().n,
    1,
  );
  assert.equal(
    new Set(calls.map((call) => call.options.headers["Idempotency-Key"])).size,
    1,
  );
  for (const call of calls)
    assert.equal(call.options.body.get("amount"), "1000");
  db.close();
});
test("signed sandbox success events persist one capture and cannot be undone by a delayed failure", async () => {
  const { db, service } = fixture();
  await service.checkout({ id: "customer" }, "booking");
  await service.ingest(success());
  assert.equal((await service.ingest(success())).replayed, true);
  await service.ingest(success("evt_duplicate_success"));
  await service.ingest({
    id: "evt_old_failure",
    type: "payment_intent.payment_failed",
    livemode: false,
    data: { object: { id: "pi_fixture", amount: 1000, currency: "usd" } },
  });
  assert.equal(
    db.sqlite.prepare("SELECT status FROM mp_payments").get().status,
    "CAPTURED",
  );
  assert.equal(
    db.sqlite.prepare("SELECT status FROM mp_bookings").get().status,
    "READY",
  );
  assert.equal(
    db.sqlite.prepare("SELECT count(*) AS n FROM mp_ledger_entries").get().n,
    2,
  );
  assert.equal(
    db.sqlite
      .prepare(
        "SELECT sum(debit_cents-credit_cents) AS net FROM mp_ledger_entries",
      )
      .get().net,
    0,
  );
  assert.throws(
    () => db.sqlite.prepare("UPDATE mp_ledger_entries SET debit_cents=0").run(),
    /append-only/,
  );
  db.close();
});
test("checkout retains provider reconciliation data but withholds a secret after concurrent cancellation", async () => {
  const { db } = fixture();
  const provider = {
    mode: "sandbox",
    async createIntent() {
      db.sqlite.prepare("UPDATE mp_bookings SET status='CANCELLED'").run();
      db.sqlite.prepare("DELETE FROM mp_host_claims").run();
      return {
        id: "pi_fixture",
        livemode: false,
        amount: 1000,
        currency: "usd",
        client_secret: "test-secret",
      };
    },
  };
  const service = createPaymentService(db, { provider, clock: () => now });
  await assert.rejects(
    () => service.checkout({ id: "customer" }, "booking"),
    /reservation changed/,
  );
  assert.equal(
    db.sqlite.prepare("SELECT provider_id FROM mp_payments").get().provider_id,
    "pi_fixture",
  );
  await service.ingest(success());
  assert.equal(
    db.sqlite.prepare("SELECT status FROM mp_refunds").get().status,
    "OPEN",
  );
  db.close();
});
test("refund delivered before success produces a balanced reversal and prevents later readiness", async () => {
  const { db, service } = fixture();
  await service.checkout({ id: "customer" }, "booking");
  await service.ingest(refund());
  await service.ingest(success());
  await service.ingest(refund());
  assert.equal(
    db.sqlite.prepare("SELECT status FROM mp_payments").get().status,
    "REFUNDED",
  );
  assert.equal(
    db.sqlite.prepare("SELECT status FROM mp_refunds").get().status,
    "REFUNDED",
  );
  assert.equal(
    db.sqlite.prepare("SELECT count(*) AS n FROM mp_refunds").get().n,
    1,
  );
  assert.equal(
    db.sqlite.prepare("SELECT status FROM mp_bookings").get().status,
    "CANCELLED",
  );
  assert.equal(
    db.sqlite.prepare("SELECT count(*) AS n FROM mp_host_claims").get().n,
    0,
  );
  assert.equal(
    db.sqlite.prepare("SELECT count(*) AS n FROM mp_ledger_entries").get().n,
    4,
  );
  assert.equal(
    db.sqlite
      .prepare(
        "SELECT sum(debit_cents-credit_cents) AS net FROM mp_ledger_entries",
      )
      .get().net,
    0,
  );
  db.close();
});
test("late successful payment queues a review while retaining the terminal booking", async () => {
  const { db, service } = fixture();
  await service.checkout({ id: "customer" }, "booking");
  db.sqlite.prepare("UPDATE mp_bookings SET status='EXPIRED'").run();
  await service.ingest(success());
  assert.equal(
    db.sqlite.prepare("SELECT status FROM mp_bookings").get().status,
    "EXPIRED",
  );
  assert.equal(
    db.sqlite.prepare("SELECT status FROM mp_refunds").get().status,
    "OPEN",
  );
  db.close();
});
test("provider mismatches and inconsistent cumulative refunds make no financial changes", async () => {
  const { db, service } = fixture();
  await service.checkout({ id: "customer" }, "booking");
  const wrong = success();
  wrong.data.object.amount = 2000;
  await assert.rejects(() => service.ingest(wrong), /match/);
  const partial = refund();
  partial.data.object.amount_refunded = 500;
  await assert.rejects(() => service.ingest(partial), /cumulative refund/);
  assert.equal(
    db.sqlite.prepare("SELECT count(*) AS n FROM mp_ledger_entries").get().n,
    0,
  );
  db.close();
});
test("capture crossing an accepted deadline atomically expires and queues review", async () => {
  const { db, service } = fixture();
  await service.checkout({ id: "customer" }, "booking");
  const delayed = createPaymentService(db, { clock: () => now + 180001 });
  await delayed.ingest(success());
  assert.equal(
    db.sqlite.prepare("SELECT status FROM mp_bookings").get().status,
    "EXPIRED",
  );
  assert.equal(
    db.sqlite.prepare("SELECT status FROM mp_refunds").get().status,
    "OPEN",
  );
  assert.equal(
    db.sqlite.prepare("SELECT count(*) AS n FROM mp_host_claims").get().n,
    0,
  );
  await delayed.ingest(refund());
  await delayed.ingest(success("evt_after_refund"));
  assert.equal(
    db.sqlite.prepare("SELECT status FROM mp_refunds").get().status,
    "REFUNDED",
  );
  db.close();
});
test("webhook verification requires raw-body signature, current timestamp and sandbox event", async () => {
  const secret = "whsec_fixture",
    stamp = String(now / 1000);
  async function sign(raw) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return (
      "t=" +
      stamp +
      ",v1=" +
      Buffer.from(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(stamp + "." + raw),
        ),
      ).toString("hex")
    );
  }
  const raw = JSON.stringify(success());
  const signature = await sign(raw);
  assert.equal(
    (await verifyStripeWebhook(raw, signature, secret, now)).id,
    "evt_success",
  );
  await assert.rejects(() =>
    verifyStripeWebhook(raw + " ", signature, secret, now),
  );
  await assert.rejects(() =>
    verifyStripeWebhook(raw, signature, secret, now + 301000),
  );
  const live = JSON.stringify({ ...success(), livemode: true });
  await assert.rejects(() =>
    sign(live).then((s) => verifyStripeWebhook(live, s, secret, now)),
  );
});
test("private room adapter binds tokens to a room, limits lifetime and disables recording", async () => {
  assert.throws(
    () => createDailyTestProvider({ apiKey: "test" }),
    /authorized/,
  );
  const calls = [];
  const video = createDailyTestProvider({
    apiKey: "fixture",
    allowTestRooms: true,
    fetcher: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return Response.json({
        url: "https://test.daily.co/hc-test-booking",
        token: "test-token",
      });
    },
  });
  await video.createRoom(
    { bookingId: "booking", format: "audio", expiresAt: now + 900000 },
    now,
  );
  await video.participantToken(
    {
      roomName: "hc-test-booking",
      actorId: "customer",
      expiresAt: now + 900000,
    },
    now,
  );
  assert.equal(calls[0].body.privacy, "private");
  assert.equal(calls[0].body.properties.enable_transcription_storage, false);
  assert.equal(calls[0].body.properties.max_participants, 2);
  assert.equal(calls[1].body.properties.user_id, "customer");
  assert.equal(calls[1].body.properties.is_owner, false);
  assert.equal(calls[1].body.properties.enable_recording_ui, false);
  assert.equal(calls[1].body.properties.start_cloud_recording, false);
  assert.equal(calls[1].body.properties.auto_start_transcription, false);
  await assert.rejects(() =>
    video.participantToken(
      { roomName: "wrong-room", actorId: "customer", expiresAt: now + 900000 },
      now,
    ),
  );
});

test("optional tips preserve all principal for the host and cannot duplicate or change after creation", async () => {
  const f = fixture();
  await f.service.checkout({ id: "customer" }, "booking");
  await f.service.ingest(success());
  f.db.sqlite.prepare("UPDATE mp_bookings SET status='COMPLETED'").run();
  const provider = {
    mode: "sandbox",
    async createTipIntent({ amountCents }) {
      return {
        id: "pi_tipfixture",
        livemode: false,
        amount: amountCents,
        currency: "usd",
        client_secret: "tip-secret",
      };
    },
  };
  const service = createPaymentService(f.db, { provider, clock: () => now });
  const result = await service.tip(
    { id: "customer" },
    "booking",
    500,
    "tip-key",
  );
  assert.equal(result.clientSecret, "tip-secret");
  await service.tip({ id: "customer" }, "booking", 500, "tip-key");
  await assert.rejects(
    () => service.tip({ id: "customer" }, "booking", 200, "other-key"),
    /different tip/,
  );
  const event = {
    id: "evt_tip",
    type: "payment_intent.succeeded",
    livemode: false,
    data: {
      object: {
        id: "pi_tipfixture",
        amount: 500,
        amount_received: 500,
        currency: "usd",
      },
    },
  };
  await service.ingest(event);
  await service.ingest(event);
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT sum(credit_cents) n FROM mp_ledger_entries WHERE account='host_tip_payable'",
      )
      .get().n,
    500,
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_tips").get().n,
    1,
  );
  f.db.close();
});
test("approved sandbox refund submission retries with a stable provider key and waits for signed confirmation", async () => {
  const f = fixture();
  await f.service.checkout({ id: "customer" }, "booking");
  await f.service.ingest(success());
  f.db.sqlite
    .prepare("INSERT INTO mp_user_roles VALUES('outsider','finance')")
    .run();
  f.db.sqlite
    .prepare(
      "INSERT INTO mp_refunds(id,booking_id,payment_id,reason,status,created_at,updated_at) SELECT 'refund',booking_id,id,'Fixture','APPROVED',?,? FROM mp_payments",
    )
    .run(now, now);
  const calls = [];
  const provider = {
    mode: "sandbox",
    async refund(input, key) {
      calls.push(key);
      return {
        id: "re_fixture",
        livemode: false,
        amount: 1000,
        payment_intent: "pi_fixture",
      };
    },
  };
  const service = createPaymentService(f.db, { provider, clock: () => now });
  await assert.rejects(
    () => service.dispatchRefund({ id: "customer", stepUp: true }, "refund"),
    (e) => e.status === 403,
  );
  await assert.rejects(
    () => service.dispatchRefund({ id: "outsider", stepUp: false }, "refund"),
    (e) => e.status === 403,
  );
  assert.equal(
    (await service.dispatchRefund({ id: "outsider", stepUp: true }, "refund"))
      .awaitingProvider,
    true,
  );
  await service.dispatchRefund({ id: "outsider", stepUp: true }, "refund");
  assert.equal(calls.length, 1);
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_refunds").get().status,
    "APPROVED",
  );
  await service.ingest(refund());
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_refunds").get().status,
    "REFUNDED",
  );
  f.db.close();
});
test("reconciliation records provider fees independently from host principal", async () => {
  const f = fixture();
  await f.service.checkout({ id: "customer" }, "booking");
  await f.service.ingest(success());
  f.db.sqlite
    .prepare("INSERT INTO mp_user_roles VALUES('outsider','finance')")
    .run();
  const intent = {
    ...success().data.object,
    status: "succeeded",
    latest_charge: {
      balance_transaction: {
        id: "txn_fee",
        currency: "usd",
        amount: 1000,
        fee: 59,
      },
    },
  };
  const service = createPaymentService(f.db, {
    provider: {
      mode: "sandbox",
      async retrieveIntent() {
        return intent;
      },
    },
    clock: () => now,
  });
  await service.reconcile(
    { id: "outsider", stepUp: true },
    f.db.sqlite.prepare("SELECT id FROM mp_payments").get().id,
  );
  await service.reconcile(
    { id: "outsider", stepUp: true },
    f.db.sqlite.prepare("SELECT id FROM mp_payments").get().id,
  );
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT sum(debit_cents) n FROM mp_ledger_entries WHERE account='processing_fee_expense'",
      )
      .get().n,
    59,
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT sum(debit_cents-credit_cents) n FROM mp_ledger_entries")
      .get().n,
    0,
  );
  f.db.close();
});
test("out-of-order dispute closure keeps its final disposition and reconciles actual provider balance movements once", async () => {
  const f = fixture();
  await f.service.checkout({ id: "customer" }, "booking");
  await f.service.ingest(success());
  const payload = {
    id: "dp_fixture",
    payment_intent: "pi_fixture",
    currency: "usd",
    amount: 1000,
    status: "won",
    balance_transactions: [
      { id: "txn_withdrawn", currency: "usd", amount: -1000, fee: 150 },
      { id: "txn_reinstated", currency: "usd", amount: 1000, fee: 0 },
    ],
  };
  await f.service.ingest({
    id: "evt_dp_close",
    type: "charge.dispute.closed",
    livemode: false,
    data: { object: payload },
  });
  await f.service.ingest({
    id: "evt_dp_old",
    type: "charge.dispute.created",
    livemode: false,
    data: { object: { ...payload, status: "needs_response" } },
  });
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_disputes").get().status,
    "won",
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_payments").get().status,
    "CAPTURED",
  );
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT sum(debit_cents-credit_cents) n FROM mp_ledger_entries WHERE account='dispute_receivable'",
      )
      .get().n,
    0,
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT sum(debit_cents-credit_cents) n FROM mp_ledger_entries")
      .get().n,
    0,
  );
  f.db.close();
});
test("lost dispute converts the provider-withdrawn principal into a balanced loss once", async () => {
  const f = fixture();
  await f.service.checkout({ id: "customer" }, "booking");
  await f.service.ingest(success());
  const event = {
    id: "evt_dp_lost",
    type: "charge.dispute.closed",
    livemode: false,
    data: {
      object: {
        id: "dp_lost",
        payment_intent: "pi_fixture",
        amount: 1000,
        currency: "usd",
        status: "lost",
        balance_transactions: [
          { id: "txn_lost", currency: "usd", amount: -1000, fee: 0 },
        ],
      },
    },
  };
  await f.service.ingest(event);
  await f.service.ingest(event);
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT sum(debit_cents) n FROM mp_ledger_entries WHERE account='dispute_loss_expense'",
      )
      .get().n,
    1000,
  );
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT sum(debit_cents-credit_cents) n FROM mp_ledger_entries WHERE account='dispute_receivable'",
      )
      .get().n,
    0,
  );
  f.db.close();
});

function cumulativeRefund(cents, id = "evt_partial_" + cents) {
  const event = refund();
  event.id = id;
  event.data.object.amount_refunded = cents;
  event.data.object.refunded = cents === 1000;
  return event;
}
function allocateDelivered(f) {
  f.db.sqlite.prepare("UPDATE mp_bookings SET status='COMPLETED'").run();
  const p = f.db.sqlite.prepare("SELECT * FROM mp_payments").get();
  for (const [account, debit, credit] of [
    ["service_liability", 1000, 0],
    ["host_base_payable", 0, 700],
    ["platform_revenue", 0, 300],
  ])
    f.db.sqlite
      .prepare("INSERT INTO mp_ledger_entries VALUES(?,?,?,?,?,?,?,?)")
      .run(
        crypto.randomUUID(),
        "booking",
        p.id,
        "delivery:" + p.id,
        account,
        debit,
        credit,
        now,
      );
}
function balance(db, account) {
  return db.sqlite
    .prepare(
      "SELECT COALESCE(sum(credit_cents-debit_cents),0) n FROM mp_ledger_entries WHERE account=?",
    )
    .get(account).n;
}
test("cumulative partial refunds reverse delivered allocations once and converge under out-of-order callbacks", async () => {
  const f = fixture();
  await f.service.checkout({ id: "customer" }, "booking");
  await f.service.ingest(success());
  allocateDelivered(f);
  await f.service.ingest(cumulativeRefund(333));
  assert.equal(balance(f.db, "host_base_payable"), 467);
  assert.equal(balance(f.db, "platform_revenue"), 200);
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_payments").get().status,
    "CAPTURED",
  );
  await f.service.ingest(cumulativeRefund(200, "evt_older"));
  await f.service.ingest(cumulativeRefund(333, "evt_duplicate_state"));
  await f.service.ingest(cumulativeRefund(333));
  assert.equal(balance(f.db, "host_base_payable"), 467);
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_refund_steps").get().n,
    1,
  );
  await Promise.all([
    f.service.ingest(cumulativeRefund(700)),
    f.service.ingest(refund()),
    f.service.ingest(cumulativeRefund(500)),
  ]);
  assert.equal(balance(f.db, "host_base_payable"), 0);
  assert.equal(balance(f.db, "platform_revenue"), 0);
  assert.equal(
    f.db.sqlite
      .prepare("SELECT refunded_cents FROM mp_payment_refund_totals")
      .get().refunded_cents,
    1000,
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_payments").get().status,
    "REFUNDED",
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT sum(debit_cents-credit_cents) n FROM mp_ledger_entries")
      .get().n,
    0,
  );
  assert.throws(
    () =>
      f.db.sqlite
        .prepare("UPDATE mp_refund_steps SET cumulative_cents=1")
        .run(),
    /append-only/,
  );
  f.db.close();
});
test("partial refund before capture preserves remaining liability and prevents later session readiness", async () => {
  const f = fixture();
  await f.service.checkout({ id: "customer" }, "booking");
  await f.service.ingest(cumulativeRefund(400));
  await f.service.ingest(success());
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_bookings").get().status,
    "CANCELLED",
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_host_claims").get().n,
    0,
  );
  assert.equal(balance(f.db, "service_liability"), 600);
  assert.equal(balance(f.db, "processor_clearing"), -600);
  f.db.close();
});
test("reviewed partial awards freeze the approved amount, survive retries and permit a later remaining-principal review", async () => {
  const f = fixture();
  await f.service.checkout({ id: "customer" }, "booking");
  await f.service.ingest(success());
  allocateDelivered(f);
  f.db.sqlite
    .prepare("INSERT INTO mp_user_roles VALUES('outsider','finance')")
    .run();
  f.db.sqlite
    .prepare(
      "INSERT INTO mp_refunds(id,booking_id,payment_id,reason,status,created_at,updated_at) SELECT 'review',booking_id,id,'Fixture','OPEN',?,? FROM mp_payments",
    )
    .run(now, now);
  const actor = { id: "outsider", stepUp: true },
    payload = {
      refundId: "review",
      status: "APPROVED",
      reason: "Proportional service adjustment",
      amountCents: 300,
    };
  await assert.rejects(
    () =>
      f.service.reviewRefund(
        { id: "customer", stepUp: true },
        payload,
        "decision",
      ),
    /finance/,
  );
  await assert.rejects(
    () =>
      f.service.reviewRefund(
        actor,
        { ...payload, amountCents: 1001 },
        "excess",
      ),
    /remaining/,
  );
  const award = await f.service.reviewRefund(actor, payload, "decision");
  assert.equal(award.amountCents, 300);
  assert.equal(
    (await f.service.reviewRefund(actor, payload, "decision")).awardId,
    award.awardId,
  );
  await assert.rejects(
    () =>
      f.service.reviewRefund(
        actor,
        { ...payload, amountCents: 301 },
        "decision",
      ),
    /another decision/,
  );
  const calls = [];
  const provider = {
    mode: "sandbox",
    async refund(input, key) {
      calls.push({ input, key });
      return {
        id: "re_partial",
        livemode: false,
        amount: input.amountCents,
        payment_intent: input.paymentIntentId,
      };
    },
  };
  const service = createPaymentService(f.db, { provider, clock: () => now });
  await service.dispatchRefund(actor, "review");
  await service.dispatchRefund(actor, "review");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.amountCents, 300);
  assert.equal(calls[0].key, "hc-refund-" + award.awardId);
  await service.ingest(cumulativeRefund(300));
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_refund_awards").get().status,
    "CONFIRMED",
  );
  f.db.sqlite.prepare("UPDATE mp_refunds SET status='OPEN'").run();
  const second = await service.reviewRefund(
    actor,
    {
      refundId: "review",
      status: "APPROVED",
      reason: "Refund remaining principal",
    },
    "decision2",
  );
  assert.equal(second.amountCents, 700);
  assert.throws(
    () =>
      f.db.sqlite.prepare("UPDATE mp_refund_awards SET amount_cents=1").run(),
    /immutable/,
  );
  f.db.close();
});
test("rejected financial review retries return the original result after the case closes", async () => {
  const f = fixture();
  await f.service.checkout({ id: "customer" }, "booking");
  await f.service.ingest(success());
  f.db.sqlite
    .prepare("INSERT INTO mp_user_roles VALUES('outsider','finance')")
    .run();
  f.db.sqlite
    .prepare(
      "INSERT INTO mp_refunds(id,booking_id,payment_id,reason,status,created_at,updated_at) SELECT 'review',booking_id,id,'Fixture','OPEN',?,? FROM mp_payments",
    )
    .run(now, now);
  const actor = { id: "outsider", stepUp: true },
    payload = {
      refundId: "review",
      status: "REJECTED",
      reason: "Reviewed service was delivered",
    };
  await f.service.reviewRefund(actor, payload, "reject");
  assert.equal(
    (await f.service.reviewRefund(actor, payload, "reject")).replayed,
    true,
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_refund_decisions").get().n,
    1,
  );
  f.db.close();
});
test("provider reconciliation applies missing cumulative refund evidence from the expanded charge", async () => {
  const f = fixture();
  await f.service.checkout({ id: "customer" }, "booking");
  await f.service.ingest(success());
  f.db.sqlite
    .prepare("INSERT INTO mp_user_roles VALUES('outsider','finance')")
    .run();
  const provider = {
    mode: "sandbox",
    async retrieveIntent() {
      return {
        ...success().data.object,
        status: "succeeded",
        latest_charge: cumulativeRefund(250).data.object,
      };
    },
  };
  const service = createPaymentService(f.db, { provider, clock: () => now });
  const id = f.db.sqlite.prepare("SELECT id FROM mp_payments").get().id;
  await service.reconcile({ id: "outsider", stepUp: true }, id);
  await service.reconcile({ id: "outsider", stepUp: true }, id);
  assert.equal(
    f.db.sqlite
      .prepare("SELECT refunded_cents FROM mp_payment_refund_totals")
      .get().refunded_cents,
    250,
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_refund_steps").get().n,
    1,
  );
  f.db.close();
});

test("large supported charge allocations use integer arithmetic at proportional refund boundaries", async () => {
  const f = fixture(),
    amount = 99999989,
    refunded = 49999997;
  const host = Number((BigInt(amount) * 7000n + 5000n) / 10000n);
  const hostReversal = Number(
    (BigInt(refunded) * BigInt(host) + BigInt(amount) / 2n) / BigInt(amount),
  );
  f.db.sqlite
    .prepare("UPDATE mp_bookings SET status='COMPLETED',amount_cents=?")
    .run(amount);
  f.db.sqlite
    .prepare(
      "INSERT INTO mp_payments VALUES('large','booking','pi_fixture','CAPTURED',?,'USD',?,?)",
    )
    .run(amount, now, now);
  for (const [account, debit, credit] of [
    ["service_liability", amount, 0],
    ["host_base_payable", 0, host],
    ["platform_revenue", 0, amount - host],
  ])
    f.db.sqlite
      .prepare("INSERT INTO mp_ledger_entries VALUES(?,?,?,?,?,?,?,?)")
      .run(
        crypto.randomUUID(),
        "booking",
        "large",
        "delivery:large",
        account,
        debit,
        credit,
        now,
      );
  const event = cumulativeRefund(refunded, "large-refund");
  event.data.object.amount = amount;
  await f.service.ingest(event);
  assert.equal(balance(f.db, "host_base_payable"), host - hostReversal);
  assert.equal(
    balance(f.db, "platform_revenue"),
    amount - host - (refunded - hostReversal),
  );
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT count(*) n FROM mp_ledger_entries WHERE typeof(debit_cents)<>'integer' OR typeof(credit_cents)<>'integer'",
      )
      .get().n,
    0,
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT sum(debit_cents-credit_cents) n FROM mp_ledger_entries")
      .get().n,
    0,
  );
  f.db.close();
});

test("tip cumulative partial refunds converge before capture and preserve only remaining host principal", async () => {
  const f = fixture();
  await f.service.checkout({ id: "customer" }, "booking");
  await f.service.ingest(success());
  f.db.sqlite
    .prepare(
      "INSERT INTO mp_tips VALUES('tip','booking','customer','pi_tip',500,'tip-key','digest','PENDING',?,?)",
    )
    .run(now, now);
  const event = (amount, id = "evt_tip_refund_" + amount) => ({
    id,
    type: "charge.refunded",
    livemode: false,
    data: {
      object: {
        id: "ch_tip",
        payment_intent: "pi_tip",
        amount: 500,
        amount_refunded: amount,
        refunded: amount === 500,
        currency: "usd",
      },
    },
  });
  await f.service.ingest(event(150));
  await f.service.ingest(event(400));
  await f.service.ingest(event(200));
  await f.service.ingest(event(400, "evt_duplicate_tip_refund"));
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT sum(credit_cents-debit_cents) n FROM mp_ledger_entries WHERE account='host_tip_payable'",
      )
      .get().n,
    100,
  );
  await f.service.ingest(event(500));
  await f.service.ingest({
    id: "evt_tip_late_capture",
    type: "payment_intent.succeeded",
    livemode: false,
    data: {
      object: {
        id: "pi_tip",
        amount: 500,
        amount_received: 500,
        currency: "usd",
      },
    },
  });
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_tips").get().status,
    "REFUNDED",
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT refunded_cents FROM mp_tip_refund_totals").get()
      .refunded_cents,
    500,
  );
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT sum(credit_cents-debit_cents) n FROM mp_ledger_entries WHERE account='host_tip_payable'",
      )
      .get().n,
    0,
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT sum(credit_cents-debit_cents) n FROM mp_ledger_entries")
      .get().n,
    0,
  );
  f.db.close();
});
test("tip refund submissions retain a stable remaining-principal snapshot through ambiguous provider retries", async () => {
  const f = fixture();
  await f.service.checkout({ id: "customer" }, "booking");
  await f.service.ingest(success());
  await f.service.ingest(refund());
  f.db.sqlite
    .prepare("INSERT INTO mp_user_roles VALUES('outsider','finance')")
    .run();
  f.db.sqlite
    .prepare(
      "INSERT INTO mp_tips VALUES('tip','booking','customer','pi_tip',500,'tip-key','digest','CAPTURED',?,?)",
    )
    .run(now, now);
  let current = now,
    attempt = 0;
  const calls = [];
  const service = createPaymentService(f.db, {
    clock: () => current,
    provider: {
      mode: "sandbox",
      async refund(input, key) {
        calls.push({ input, key });
        if (attempt++ === 0) throw Error("Fixture network interruption");
        return {
          id: "re_tip_fixture",
          livemode: false,
          amount: input.amountCents,
          payment_intent: input.paymentIntentId,
        };
      },
    },
  });
  await assert.rejects(() =>
    service.refundTip({ id: "outsider", stepUp: true }, "booking"),
  );
  current += 5000;
  assert.equal((await service.retryPending()).processed, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[1].input.amountCents, 500);
  await service.refundTip({ id: "outsider", stepUp: true }, "booking");
  assert.equal(calls.length, 2);
  f.db.close();
});
