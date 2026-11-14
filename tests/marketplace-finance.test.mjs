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
test("provider mismatch and unsupported partial refunds make no financial changes", async () => {
  const { db, service } = fixture();
  await service.checkout({ id: "customer" }, "booking");
  const wrong = success();
  wrong.data.object.amount = 2000;
  await assert.rejects(() => service.ingest(wrong), /match/);
  const partial = refund();
  partial.data.object.amount_refunded = 500;
  await assert.rejects(() => service.ingest(partial), /Partial refunds/);
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
