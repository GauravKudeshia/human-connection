import test from "node:test";
import assert from "node:assert/strict";
import { sqliteD1 } from "./marketplace-db.mjs";
import { createMarketplace } from "../lib/marketplace/store.mjs";
import { createOnboarding } from "../lib/marketplace/onboarding.mjs";
import {
  readMarketplace,
  actMarketplace,
} from "../lib/marketplace/http-handlers.mjs";

async function fixture() {
  const db = sqliteD1(),
    service = createMarketplace(db);
  const customer = await service.provisionIdentity({
    subject: "request-customer",
    displayName: "Test customer",
  });
  const host = await service.provisionIdentity({
    subject: "request-host",
    displayName: "Test host",
  });
  const other = await service.provisionIdentity({
    subject: "request-other",
    displayName: "Test other",
  });
  const now = Date.now(),
    bookingId = crypto.randomUUID(),
    quote = { totalCents: 1000, currency: "USD", expiresAt: now + 180000 };
  await db
    .prepare(
      "INSERT INTO mp_bookings(id,customer_id,host_id,request_key,fingerprint,experience,duration,format,language,quote,amount_cents,currency,status,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,'laugh',15,'video','English',?,1000,'USD','COMPLETED',?,?,?)",
    )
    .bind(
      bookingId,
      customer.id,
      host.id,
      "request",
      "digest",
      JSON.stringify(quote),
      now + 180000,
      now,
      now,
    )
    .run();
  return { db, service, customer, host, other, bookingId };
}
test("eligibility is persisted and enforced before a new reservation", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await assert.rejects(
    () =>
      f.service.act(
        f.customer,
        "reserve",
        {
          experience: "laugh",
          duration: 15,
          format: "video",
          language: "English",
        },
        "reserve",
      ),
    (e) => e.code === "ELIGIBILITY_REQUIRED",
  );
  const context = {
    db: f.db,
    service: f.service,
    actor: f.customer,
    config: {},
  };
  await actMarketplace(
    context,
    "customer-eligibility",
    { adult: true, us: true, accepted: true, policyVersion: "beta-2026-11" },
    "eligible",
  );
  assert.equal((await readMarketplace(context, "me")).eligible, true);
});
test("completed value-only and private feedback edits preserve an independent public rating", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const now = Date.now();
  await f.db
    .prepare(
      "INSERT INTO mp_payments VALUES('review-payment',?,'pi_review_fixture','CAPTURED',1000,'USD',?,?)",
    )
    .bind(f.bookingId, now, now)
    .run();
  await f.service.act(
    f.customer,
    "review",
    { bookingId: f.bookingId, rating: 4 },
    "rating",
  );
  await f.service.act(
    f.customer,
    "review",
    { bookingId: f.bookingId, worthIt: true },
    "value",
  );
  await f.service.act(
    f.customer,
    "review",
    { bookingId: f.bookingId, privateFeedback: "Private test quality note" },
    "quality",
  );
  const row = await f.db
    .prepare("SELECT * FROM mp_reviews WHERE booking_id=?")
    .bind(f.bookingId)
    .first();
  assert.equal(row.rating, 4);
  assert.equal(row.worth_it, 1);
  assert.equal(row.private_feedback, "Private test quality note");
});
test("the HTTP service receipt projection is owned and has explicit unpaid totals", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const context = {
    db: f.db,
    service: f.service,
    actor: f.customer,
    config: {},
  };
  const receipt = await readMarketplace(context, "receipt", f.bookingId);
  assert.equal(receipt.receipt.baseCharge, 0);
  assert.equal(receipt.receipt.net, 0);
  await assert.rejects(
    () =>
      readMarketplace({ ...context, actor: f.other }, "receipt", f.bookingId),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => readMarketplace(context, "host-earnings"),
    (e) => e.status === 403,
  );
});
test("customer policy acceptance records cannot be overwritten or deleted", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const onboarding = createOnboarding(f.db, { authorize: f.service.authorize });
  await onboarding.act(
    f.customer,
    "customer-eligibility",
    { adult: true, us: true, accepted: true, policyVersion: "beta-2026-11" },
    "accept-policy",
  );
  assert.throws(
    () =>
      f.db.sqlite.exec("UPDATE mp_policy_acceptances SET version='changed'"),
    /immutable|append-only/i,
  );
});
