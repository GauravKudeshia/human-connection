import test from "node:test";
import assert from "node:assert/strict";
import { sqliteD1 } from "./marketplace-db.mjs";
import { createPayoutService } from "../lib/marketplace/payouts.mjs";
import { createStripeSandbox } from "../lib/marketplace/providers.mjs";
const now = 1800000000000;
function fixture(options = {}) {
  const db = sqliteD1();
  for (const id of ["customer", "host", "maker", "checker", "safety"])
    db.sqlite
      .prepare(
        "INSERT INTO mp_users(id,provider_subject,display_name,created_at) VALUES(?,?,?,?)",
      )
      .run(id, id, id, now);
  for (const [id, role] of [
    ["host", "host"],
    ["maker", "finance"],
    ["checker", "finance"],
    ["safety", "safety"],
  ])
    db.sqlite.prepare("INSERT INTO mp_user_roles VALUES(?,?)").run(id, role);
  db.sqlite
    .prepare(
      "INSERT INTO mp_host_profiles(user_id,display_name,biography,languages,formats,styles,status,policy_version,training_version,created_at,updated_at) VALUES('host','Host','Fixture','[]','[]','[]','APPROVED','v1','v1',?,?)",
    )
    .run(now, now);
  db.sqlite
    .prepare(
      "INSERT INTO mp_host_verifications VALUES('host','VERIFIED','vs_fixture',1,'US','ELIGIBLE',?)",
    )
    .run(now);
  db.sqlite
    .prepare(
      "INSERT INTO mp_host_verification_evidence VALUES('host','vs_fixture','acct_fixture','checker',?)",
    )
    .run(now);
  db.sqlite
    .prepare(
      "INSERT INTO mp_bookings(id,customer_id,host_id,request_key,fingerprint,experience,duration,format,language,quote,amount_cents,currency,status,expires_at,created_at,updated_at) VALUES('booking','customer','host','key','digest','laugh',15,'video','English','{}',1000,'USD','COMPLETED',?,?,?)",
    )
    .run(now, now - 10 * 86400000, now - 8 * 86400000);
  db.sqlite
    .prepare(
      "INSERT INTO mp_payments VALUES('payment','booking','pi_fixture','CAPTURED',1000,'USD',?,?)",
    )
    .run(now - 8 * 86400000, now - 8 * 86400000);
  for (const [account, debit, credit] of [
    ["service_liability", 1000, 0],
    ["host_base_payable", 0, 700],
    ["platform_revenue", 0, 300],
  ])
    db.sqlite
      .prepare("INSERT INTO mp_ledger_entries VALUES(?,?,?,?,?,?,?,?)")
      .run(
        crypto.randomUUID(),
        "booking",
        "payment",
        "delivery:payment",
        account,
        debit,
        credit,
        now - 8 * 86400000,
      );
  const calls = [],
    objects = new Map();
  const provider = {
    mode: "sandbox",
    async createTransfer(input, key) {
      calls.push({ input, key });
      const transfer = {
        id: "tr_fixture",
        livemode: false,
        amount: input.amountCents,
        currency: "usd",
        destination: input.destination,
        metadata: { batch_id: input.batchId },
        amount_reversed: 0,
      };
      objects.set(transfer.id, transfer);
      return transfer;
    },
    async retrieveTransfer(id) {
      return objects.get(id);
    },
  };
  const service = createPayoutService(db, {
    provider,
    authorize: async () => {},
    allowTestTransfers: true,
    clock: () => now,
    ...options,
  });
  return { db, service, provider, calls, objects };
}
const maker = { id: "maker", stepUp: true },
  checker = { id: "checker", stepUp: true };
test("test transfers default disabled and require finance MFA, verified destinations and distinct reviewer", async () => {
  const f = fixture();
  const disabled = createPayoutService(f.db, {
    provider: f.provider,
    authorize: async () => {},
    clock: () => now,
  });
  await assert.rejects(
    () => disabled.request(maker, { hostId: "host", reason: "Fixture" }, "key"),
    /disabled/,
  );
  await assert.rejects(
    () =>
      f.service.request(
        { id: "safety", stepUp: true },
        { hostId: "host", reason: "Fixture" },
        "key",
      ),
    /finance/,
  );
  await assert.rejects(
    () =>
      f.service.request(
        { ...maker, stepUp: false },
        { hostId: "host", reason: "Fixture" },
        "key",
      ),
    /finance/,
  );
  const batch = await f.service.request(
    maker,
    { hostId: "host", reason: "Fixture" },
    "key",
  );
  assert.equal(batch.amountCents, 700);
  assert.equal(batch.bankPayout, false);
  assert.equal(batch.kind, "connected-account-transfer");
  await assert.rejects(
    () => f.service.approve(maker, batch.id),
    /different finance reviewer/,
  );
  await assert.rejects(
    () => f.service.dispatch(checker, batch.id),
    /second reviewer/,
  );
  f.db.sqlite
    .prepare("UPDATE mp_host_verifications SET payout_status='SUSPENDED'")
    .run();
  await assert.rejects(
    () => f.service.approve(checker, batch.id),
    /verified approved/,
  );
  assert.equal(f.calls.length, 0);
  f.db.close();
});
test("sandbox transfer requests reserve earnings globally, reconcile immutable allocations, and cannot duplicate", async () => {
  const f = fixture();
  const batch = await f.service.request(
    maker,
    { hostId: "host", reason: "Fixture" },
    "key",
  );
  assert.equal(
    (
      await f.service.request(
        maker,
        { hostId: "host", reason: "Fixture" },
        "key",
      )
    ).id,
    batch.id,
  );
  await assert.rejects(
    () =>
      f.service.request(maker, { hostId: "host", reason: "Different" }, "key"),
    /different transfer/,
  );
  await assert.rejects(
    () =>
      f.service.request(
        checker,
        { hostId: "host", reason: "Fixture" },
        "newkey",
      ),
    /no unreserved/,
  );
  await f.service.approve(checker, batch.id);
  await f.service.dispatch(checker, batch.id);
  await f.service.dispatch(checker, batch.id);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].key, "hc-test-transfer-" + batch.id);
  await f.service.reconcile(checker, batch.id);
  await f.service.reconcile(checker, batch.id);
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT sum(credit_cents-debit_cents) n FROM mp_ledger_entries WHERE account='host_base_payable'",
      )
      .get().n,
    0,
  );
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT count(*) n FROM mp_ledger_entries WHERE event_id LIKE 'transfer:%'",
      )
      .get().n,
    2,
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_payout_holds").get().n,
    0,
  );
  await assert.rejects(
    () =>
      f.service.request(maker, { hostId: "host", reason: "Again" }, "another"),
    /no unreserved/,
  );
  f.db.close();
});
test("settlement, pending refund and disputed principal cannot be dispatched", async () => {
  const f = fixture();
  const batch = await f.service.request(
    maker,
    { hostId: "host", reason: "Fixture" },
    "key",
  );
  await f.service.approve(checker, batch.id);
  f.db.sqlite
    .prepare(
      "INSERT INTO mp_refunds(id,booking_id,payment_id,reason,status,created_at,updated_at) VALUES('refund','booking','payment','Review','OPEN',?,?)",
    )
    .run(now, now);
  await assert.rejects(
    () => f.service.dispatch(checker, batch.id),
    /requires a new transfer review/,
  );
  assert.equal(f.calls.length, 0);
  f.db.sqlite.prepare("UPDATE mp_refunds SET status='REJECTED'").run();
  f.db.sqlite.prepare("UPDATE mp_payments SET status='DISPUTED'").run();
  await assert.rejects(
    () => f.service.dispatch(checker, batch.id),
    /requires a new transfer review/,
  );
  f.db.close();
  const fresh = fixture({ settlementDelayMs: 9 * 86400000 });
  await assert.rejects(
    () =>
      fresh.service.request(
        maker,
        { hostId: "host", reason: "Fresh" },
        "fresh",
      ),
    /no unreserved/,
  );
  fresh.db.close();
});
test("a full sandbox transfer reversal compensates its original journal once", async () => {
  const f = fixture();
  const batch = await f.service.request(
    maker,
    { hostId: "host", reason: "Fixture" },
    "key",
  );
  await f.service.approve(checker, batch.id);
  await f.service.dispatch(checker, batch.id);
  f.objects.get("tr_fixture").amount_reversed = 700;
  await f.service.reconcile(checker, batch.id);
  await f.service.reconcile(checker, batch.id);
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT sum(credit_cents-debit_cents) n FROM mp_ledger_entries WHERE account='host_base_payable'",
      )
      .get().n,
    700,
  );
  assert.equal((await f.service.read(checker)).batches[0].status, "REVERSED");
  f.db.close();
});
test("provider adapter sends test connected-account transfers with stable key and rejects live credentials", async () => {
  assert.throws(
    () => createStripeSandbox({ secretKey: "sk_live_fixture" }),
    /Live payment credentials/,
  );
  let request;
  const provider = createStripeSandbox({
    secretKey: "sk_test_fixture",
    fetcher: async (url, options) => {
      request = { url, options };
      return Response.json({ id: "tr_fixture", livemode: false });
    },
  });
  await provider.createTransfer(
    { batchId: "batch", destination: "acct_fixture", amountCents: 700 },
    "stable",
  );
  assert.equal(request.url, "https://api.stripe.com/v1/transfers");
  assert.equal(request.options.headers["Idempotency-Key"], "stable");
  const body = new URLSearchParams(request.options.body);
  assert.equal(body.get("amount"), "700");
  assert.equal(body.get("metadata[batch_id]"), "batch");
  await assert.rejects(
    () =>
      provider.createTransfer(
        { batchId: "batch", destination: "acct_fixture", amountCents: 0 },
        "stable",
      ),
    /valid sandbox/,
  );
});

test("partial transfer reversals apply only their new cents and cannot regress after stale snapshots", async () => {
  const f = fixture();
  const batch = await f.service.request(
    maker,
    { hostId: "host", reason: "Fixture" },
    "key",
  );
  await f.service.approve(checker, batch.id);
  await f.service.dispatch(checker, batch.id);
  const returned = f.objects.get("tr_fixture");
  returned.amount_reversed = 251;
  await f.service.reconcile(checker, batch.id);
  await f.service.reconcile(checker, batch.id);
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT sum(credit_cents-debit_cents) n FROM mp_ledger_entries WHERE account='host_base_payable'",
      )
      .get().n,
    251,
  );
  returned.amount_reversed = 100;
  await f.service.reconcile(checker, batch.id);
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT sum(credit_cents-debit_cents) n FROM mp_ledger_entries WHERE account='host_base_payable'",
      )
      .get().n,
    251,
  );
  returned.amount_reversed = 700;
  await f.service.reconcile(checker, batch.id);
  returned.amount_reversed = 0;
  await f.service.reconcile(checker, batch.id);
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT sum(credit_cents-debit_cents) n FROM mp_ledger_entries WHERE account='host_base_payable'",
      )
      .get().n,
    700,
  );
  assert.equal((await f.service.read(checker)).batches[0].status, "REVERSED");
  f.db.close();
});
test("never-submitted transfers can release their reservation, while submitted transfers require reconciliation", async () => {
  const f = fixture();
  const batch = await f.service.request(
    maker,
    { hostId: "host", reason: "Fixture" },
    "key",
  );
  assert.equal((await f.service.cancel(checker, batch.id)).status, "CANCELLED");
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_payout_holds").get().n,
    0,
  );
  const second = await f.service.request(
    maker,
    { hostId: "host", reason: "Fixture" },
    "second",
  );
  await f.service.approve(checker, second.id);
  await f.service.dispatch(checker, second.id);
  await assert.rejects(
    () => f.service.cancel(checker, second.id),
    /ambiguous transfer/,
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_payout_holds").get().n,
    1,
  );
  assert.throws(
    () =>
      f.db.sqlite.prepare("UPDATE mp_payout_items SET amount_cents=1").run(),
    /immutable/,
  );
  f.db.close();
});
test("untrusted actor objects fail closed when the finance resolver is absent or rejects the account", async () => {
  const f = fixture();
  const missing = createPayoutService(f.db, {
    provider: f.provider,
    allowTestTransfers: true,
  });
  await assert.rejects(
    () => missing.request(maker, { hostId: "host", reason: "Fixture" }, "key"),
    /trusted finance/,
  );
  const denied = createPayoutService(f.db, {
    provider: f.provider,
    allowTestTransfers: true,
    authorize: async () => {
      throw Error("Untrusted actor");
    },
  });
  await assert.rejects(() => denied.read(maker), /Untrusted actor/);
  f.db.close();
});
test("refund liabilities from a previously transferred session pause other host transfers", async () => {
  const f = fixture();
  const batch = await f.service.request(
    maker,
    { hostId: "host", reason: "Fixture" },
    "key",
  );
  await f.service.approve(checker, batch.id);
  await f.service.dispatch(checker, batch.id);
  await f.service.reconcile(checker, batch.id);
  f.db.sqlite
    .prepare("INSERT INTO mp_ledger_entries VALUES(?,?,?,?,?,?,?,?)")
    .run(
      "reversal",
      "booking",
      "payment",
      "refund:payment:500",
      "host_base_payable",
      350,
      0,
      now,
    );
  await assert.rejects(
    () =>
      f.service.request(maker, { hostId: "host", reason: "Again" }, "again"),
    /host liability/,
  );
  f.db.close();
});
