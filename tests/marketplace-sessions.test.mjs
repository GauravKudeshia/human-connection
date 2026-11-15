import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sqliteD1 } from "./marketplace-db.mjs";
import {
  createSessionService,
  overlapIntervals,
} from "../lib/marketplace/sessions.mjs";
import { createPaymentService } from "../lib/marketplace/finance.mjs";
import { verifyDailyWebhook } from "../lib/marketplace/providers.mjs";
const start = 1_800_000_000_000;
function fixture() {
  const db = sqliteD1();
  db.sqlite.exec(
    readFileSync(
      new URL("../db/marketplace-session-finance.sql", import.meta.url),
      "utf8",
    ),
  );
  let now = start;
  for (const id of ["customer", "host", "stranger", "reviewer"])
    db.sqlite
      .prepare(
        "INSERT INTO mp_users(id,provider_subject,display_name,created_at) VALUES(?,?,?,?)",
      )
      .run(id, id, id, start);
  db.sqlite
    .prepare(
      "INSERT INTO mp_user_roles VALUES('customer','customer'),('host','host'),('reviewer','finance')",
    )
    .run();
  db.sqlite
    .prepare(
      "INSERT INTO mp_host_profiles(user_id,display_name,biography,languages,formats,styles,status,policy_version,training_version,created_at,updated_at) VALUES('host','Host','Fixture','[]','[]','[]','APPROVED','v1','v1',?,?)",
    )
    .run(start, start);
  db.sqlite
    .prepare(
      "INSERT INTO mp_host_verifications VALUES('host','VERIFIED','fixture',1,'US','ELIGIBLE',?)",
    )
    .run(start);
  db.sqlite
    .prepare(
      "INSERT INTO mp_certifications VALUES('host','laugh','APPROVED','fixture','reviewer',1,?,?)",
    )
    .run(start, start + 86400000);
  db.sqlite
    .prepare(
      "INSERT INTO mp_bookings(id,customer_id,host_id,request_key,fingerprint,experience,duration,format,language,quote,amount_cents,currency,status,expires_at,created_at,updated_at) VALUES('booking','customer','host','fixture','digest','laugh',15,'video','English',?,1000,'USD','READY',?,?,?)",
    )
    .run(
      JSON.stringify({ hostShareBasisPoints: 7000 }),
      start + 180000,
      start,
      start,
    );
  db.sqlite
    .prepare("INSERT INTO mp_host_claims VALUES('host','customer','booking',?)")
    .run(start + 180000);
  db.sqlite
    .prepare(
      "INSERT INTO mp_payments VALUES('payment','booking','pi_fixture','CAPTURED',1000,'USD',?,?)",
    )
    .run(start, start);
  db.sqlite
    .prepare(
      "INSERT INTO mp_ledger_entries VALUES('initial1','booking','payment','capture:payment','processor_clearing',1000,0,?),('initial2','booking','payment','capture:payment','service_liability',0,1000,?)",
    )
    .run(start, start);
  const calls = [];
  const provider = {
    async createRoom({ bookingId }) {
      calls.push("create");
      return {
        name: "hc-test-" + bookingId,
        privacy: "private",
        url: "https://fixture.daily.co/hc-test-" + bookingId,
      };
    },
    async participantToken({ actorId }) {
      calls.push("token:" + actorId);
      return { token: "test-" + actorId };
    },
    async deleteRoom() {
      calls.push("delete");
    },
  };
  const service = createSessionService(db, {
    videoProvider: provider,
    clock: () => now,
  });
  const event = (type, user, joined, duration, session = user) => ({
    id: crypto.randomUUID(),
    type,
    event_ts: now / 1000,
    payload: {
      room: "hc-test-booking",
      session_id: session,
      user_id: user,
      joined_at: joined / 1000,
      ...(duration === undefined ? {} : { duration: duration / 1000 }),
    },
  });
  return {
    db,
    service,
    calls,
    provider,
    event,
    advance(ms) {
      now = start + ms;
    },
    clock: () => now,
  };
}
test("paid private grants require the matching participant and current host certification", async () => {
  const f = fixture();
  const grant = await f.service.roomToken({ id: "customer" }, "booking");
  assert.equal(grant.token, "test-customer");
  await f.service.roomToken({ id: "host" }, "booking");
  assert.equal(f.calls.filter((x) => x === "create").length, 1);
  await assert.rejects(
    () => f.service.roomToken({ id: "stranger" }, "booking"),
    (e) => e.status === 404,
  );
  f.db.sqlite.prepare("UPDATE mp_certifications SET status='REVOKED'").run();
  await assert.rejects(
    () => f.service.roomToken({ id: "customer" }, "booking"),
    /host is unavailable/,
  );
  f.db.close();
});
test("only signed-provider dual overlap completes and allocates host and platform earnings once", async () => {
  const f = fixture();
  await f.service.roomToken({ id: "customer" }, "booking");
  await f.service.ingest(f.event("participant.joined", "customer", start));
  assert.equal(
    (await f.service.read({ id: "host" }, "booking")).status,
    "READY",
  );
  await f.service.ingest(f.event("participant.joined", "host", start));
  assert.equal(
    (await f.service.read({ id: "customer" }, "booking")).status,
    "LIVE",
  );
  f.advance(900000);
  await f.service.ingest(
    f.event("participant.left", "customer", start, 900000),
  );
  assert.equal(
    (await f.service.read({ id: "customer" }, "booking")).status,
    "LIVE",
  );
  await f.service.ingest(f.event("participant.left", "host", start, 900000));
  assert.equal(
    (await f.service.read({ id: "host" }, "booking")).status,
    "COMPLETED",
  );
  const rows = f.db.sqlite
    .prepare(
      "SELECT account,credit_cents FROM mp_ledger_entries WHERE event_id='delivery:payment'",
    )
    .all();
  assert.equal(
    rows.find((r) => r.account === "host_base_payable").credit_cents,
    700,
  );
  assert.equal(
    rows.find((r) => r.account === "platform_revenue").credit_cents,
    300,
  );
  await f.service.ingest(f.event("participant.left", "host", start, 900000));
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT count(*) n FROM mp_ledger_entries WHERE event_id='delivery:payment'",
      )
      .get().n,
    3,
  );
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT sum(debit_cents-credit_cents) net FROM mp_ledger_entries",
      )
      .get().net,
    0,
  );
  f.db.close();
});
test("reconnect excludes the absence and preserves the original deadline", async () => {
  const f = fixture();
  await f.service.roomToken({ id: "customer" }, "booking");
  for (const user of ["customer", "host"])
    await f.service.ingest(f.event("participant.joined", user, start));
  f.advance(600000);
  await f.service.ingest(
    f.event("participant.left", "customer", start, 300000),
  );
  await f.service.ingest(
    f.event(
      "participant.joined",
      "customer",
      start + 600000,
      undefined,
      "rejoin",
    ),
  );
  f.advance(900000);
  await f.service.ingest(
    f.event("participant.left", "customer", start + 600000, 300000, "rejoin"),
  );
  await f.service.ingest(f.event("participant.left", "host", start, 900000));
  await f.service.expire();
  const state = await f.service.read({ id: "customer" }, "booking");
  assert.equal(state.status, "PARTIAL_DELIVERY");
  assert.equal(state.overlapMs, 600000);
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_refunds").get().status,
    "OPEN",
  );
  f.db.close();
});
test("provider left-before-joined and repeated event ids preserve a single interval", async () => {
  const f = fixture();
  await f.service.roomToken({ id: "customer" }, "booking");
  f.advance(900000);
  for (const user of ["customer", "host"])
    await f.service.ingest(f.event("participant.left", user, start, 900000));
  await f.service.ingest(f.event("participant.joined", "customer", start));
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_session_presence").get().n,
    2,
  );
  assert.equal(
    (await f.service.read({ id: "customer" }, "booking")).overlapMs,
    900000,
  );
  f.db.close();
});
test("either participant ends independently and room cleanup retries retain review evidence", async () => {
  const f = fixture();
  await f.service.roomToken({ id: "customer" }, "booking");
  f.provider.deleteRoom = async () => {
    throw new Error("Unavailable");
  };
  f.advance(10000);
  const state = await f.service.endSession({ id: "host" }, "booking");
  assert.equal(state.status, "PARTIAL_DELIVERY");
  assert.equal(state.roomCleanupPending, true);
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_host_claims").get().n,
    0,
  );
  f.provider.deleteRoom = async () => {};
  await f.service.expire();
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_video_rooms").get().status,
    "CLOSED",
  );
  f.db.close();
});
test("refund after delivery reverses earned allocation through compensating journal entries", async () => {
  const f = fixture();
  await f.service.roomToken({ id: "customer" }, "booking");
  f.advance(900000);
  for (const user of ["customer", "host"])
    await f.service.ingest(f.event("participant.left", user, start, 900000));
  await createPaymentService(f.db, { clock: f.clock }).ingest({
    id: "evt_refunded",
    type: "charge.refunded",
    livemode: false,
    data: {
      object: {
        id: "ch_fixture",
        payment_intent: "pi_fixture",
        amount: 1000,
        amount_refunded: 1000,
        currency: "usd",
        refunded: true,
      },
    },
  });
  for (const account of [
    "service_liability",
    "host_base_payable",
    "platform_revenue",
  ])
    assert.equal(
      f.db.sqlite
        .prepare(
          "SELECT COALESCE(sum(credit_cents-debit_cents),0) net FROM mp_ledger_entries WHERE account=?",
        )
        .get(account).net,
      0,
    );
  f.db.close();
});
test("duplicate overlapping connections cannot multiply attendance credit", () => {
  assert.equal(
    overlapIntervals(
      [
        { user_id: "c", joined_at: 0, left_at: 100 },
        { user_id: "c", joined_at: 25, left_at: 200 },
        { user_id: "h", joined_at: 50, left_at: 150 },
      ],
      "c",
      "h",
    ).milliseconds,
    100,
  );
});
test("Daily verifies exact raw body, base64 signing material and timestamp freshness", async () => {
  const raw = JSON.stringify({ test: "test" }),
    timestamp = String(start / 1000),
    secret = Buffer.alloc(32, 5).toString("base64");
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret, "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Buffer.from(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(timestamp + "." + raw),
    ),
  ).toString("base64");
  assert.equal(
    (await verifyDailyWebhook(raw, signature, timestamp, secret, start)).test,
    true,
  );
  await assert.rejects(() =>
    verifyDailyWebhook(raw + " ", signature, timestamp, secret, start),
  );
  await assert.rejects(() =>
    verifyDailyWebhook(raw, signature, timestamp, secret, start + 301000),
  );
});

test("a cancellation during token issuance withholds the grant and keeps provider cleanup pending", async () => {
  const f = fixture();
  f.provider.participantToken = async () => {
    f.db.sqlite.prepare("UPDATE mp_bookings SET status='CANCELLED'").run();
    f.db.sqlite.prepare("DELETE FROM mp_host_claims").run();
    return { token: "unreturned-token" };
  };
  await assert.rejects(
    () => f.service.roomToken({ id: "customer" }, "booking"),
    /ended while entry/,
  );
  await f.service.expire();
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_video_rooms").get().status,
    "CLOSED",
  );
  f.db.close();
});
test("an urgent report recorded before media termination still closes the provider room", async () => {
  const f = fixture();
  await f.service.roomToken({ id: "customer" }, "booking");
  f.db.sqlite.prepare("UPDATE mp_bookings SET status='SAFETY_ENDED'").run();
  await f.service.endSession({ id: "customer" }, "booking", "SAFETY");
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_video_rooms").get().status,
    "CLOSED",
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT reason FROM mp_session_timing").get().reason,
    "SAFETY",
  );
  f.db.close();
});
