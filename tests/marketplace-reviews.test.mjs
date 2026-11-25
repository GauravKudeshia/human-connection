import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { marketplaceFixture } from "./marketplace-fixture.mjs";
import { createMarketplaceHttp } from "../lib/marketplace/http-router.mjs";
import {
  publishedReviews,
  reviewStatistics,
} from "../lib/marketplace/reviews.mjs";

async function reviewFixture(t) {
  const f = await marketplaceFixture();
  t.after(() => f.db.close());
  const [host] = f.hosts;
  const { booking } = await f.act(f.customer, "reserve", {
    ...f.choice,
    hostId: host.id,
  });
  const charge = async (status) =>
    f.db
      .prepare(
        `INSERT INTO mp_payments VALUES('review-payment',?,'pi_review_fixture',?,1000,'USD',?,?)
         ON CONFLICT(booking_id) DO UPDATE SET status=excluded.status`,
      )
      .bind(booking.id, status, f.clock(), f.clock())
      .run();
  const delivery = (status) =>
    f.db
      .prepare("UPDATE mp_bookings SET status=? WHERE id=?")
      .bind(status, booking.id)
      .run();
  const review = (actor, fields, key) =>
    f.act(actor, "review", { bookingId: booking.id, ...fields }, key);
  const own = (actor = f.customer) =>
    f.service.read(actor, "my-review", booking.id);
  return { ...f, booking, host, charge, delivery, review, own };
}

test("only the paying customer can submit a review after capture and completed delivery", async (t) => {
  const f = await reviewFixture(t);
  const scores = { rating: 4, comfortRating: 5 };
  await f.charge("CAPTURED");
  await f.delivery("PARTIAL_DELIVERY");
  await assert.rejects(
    () => f.review(f.customer, scores),
    { code: "INVALID_STATE" },
  );
  await f.delivery("COMPLETED");
  await f.charge("PENDING");
  assert.equal((await f.own()).eligible, false);
  await assert.rejects(
    () => f.review(f.customer, scores),
    { code: "INVALID_STATE" },
  );
  await f.charge("CAPTURED");
  for (const guest of [f.host, f.other]) {
    await assert.rejects(() => f.review(guest, scores), { code: "NOT_FOUND" });
    await assert.rejects(() => f.own(guest), { code: "NOT_FOUND" });
  }
  await assert.rejects(
    () => f.review(f.customer, { ...scores, comfortRating: 6 }),
    { code: "VALIDATION" },
  );
  await assert.rejects(
    () => f.review(f.customer, { rating: 4, reviewText: "Two scores needed" }),
    { code: "VALIDATION" },
  );
  await f.review(f.customer, scores);
  assert.equal((await f.own()).review.comfortRating, 5);
  assert.equal((await f.service.read(f.customer, "bookings"))[0].review_saved, 1);
  assert.equal((await f.service.read(f.host, "bookings"))[0].review_saved, 0);
  await f.charge("DISPUTED");
  const readOnly = await f.own();
  assert.equal(readOnly.eligible, false);
  assert.equal(readOnly.review.rating, 4);
  assert.equal((await reviewStatistics(f.db, f.host.id)).ratings, 0);
  assert.equal((await reviewStatistics(f.db, f.host.id)).comfortRatings, 0);
  await assert.rejects(
    () => f.review(f.customer, scores),
    { code: "INVALID_STATE" },
  );
});

test("review requests are idempotent and old retries cannot overwrite newer ratings", async (t) => {
  const f = await reviewFixture(t);
  await f.charge("CAPTURED");
  await f.delivery("COMPLETED");
  const original = { rating: 3, comfortRating: 4 };
  const first = await Promise.all([
    f.review(f.customer, original, "first-review"),
    f.review(f.customer, original, "first-review"),
  ]);
  assert.equal(first.filter(({ replayed }) => replayed).length, 1);
  await f.review(f.customer, { rating: 5, comfortRating: 2 }, "edited-review");
  assert.equal((await f.review(f.customer, original, "first-review")).replayed, true);
  await assert.rejects(
    () => f.review(f.customer, { rating: 1 }, "first-review"),
    { code: "KEY_REUSED" },
  );
  await f.review(f.customer, { worthIt: false });
  const own = (await f.own()).review;
  assert.equal(own.rating, 5);
  assert.equal(own.comfortRating, 2);
  assert.equal(own.worthIt, false);
  const stats = await reviewStatistics(f.db, f.host.id);
  assert.equal(stats.ratings, 1);
  assert.equal(stats.comfortRatings, 1);
  assert.equal(stats.averageRating, 5);
  assert.equal(stats.averageComfortRating, 2);
});

test("only eligible independently moderated written reviews are shared without private fields", async (t) => {
  const f = await reviewFixture(t);
  await f.charge("CAPTURED");
  await f.delivery("COMPLETED");
  const scores = { rating: 4, comfortRating: 5 };
  const own = "Private note";
  const written = "The host made the conversation easy.";
  await f.review(f.customer, { ...scores, privateFeedback: own, reviewText: written });
  assert.deepEqual(await publishedReviews(f.db, f.host.id), []);
  assert.equal((await reviewStatistics(f.db, f.host.id)).publishedReviews, 0);
  assert.equal((await f.own()).review.publicationStatus, "PENDING");
  const unstepped = await f.user("unstepped-moderator", ["host_reviewer"]);
  await assert.rejects(
    () => f.service.read(unstepped, "review-moderation"),
    { code: "STEP_UP_REQUIRED" },
  );
  const moderatorHost = await f.user("test-host-0", ["host_reviewer"], true);
  assert.deepEqual(await f.service.read(moderatorHost, "review-moderation"), []);
  const [pending] = await f.service.read(f.reviewer, "review-moderation");
  assert.equal(pending.reviewText, written);
  assert(!JSON.stringify(pending).includes(own));
  const moderate = (actor, version, publicationStatus = "APPROVED") =>
    f.act(actor, "review-publication", {
      bookingId: f.booking.id,
      textVersion: version,
      publicationStatus,
    });
  await assert.rejects(() => moderate(moderatorHost, pending.textVersion), {
    code: "INVALID_STATE",
  });
  await moderate(f.reviewer, pending.textVersion);
  assert.deepEqual(await publishedReviews(f.db, f.host.id), [written]);
  assert.equal((await reviewStatistics(f.db, f.host.id)).publishedReviews, 1);
  assert.deepEqual(await f.service.read(f.reviewer, "review-moderation"), []);
  assert.equal(
    (await f.service.read(f.reviewer, "review-published"))[0].bookingId,
    f.booking.id,
  );
  await f.review(f.customer, { ...scores, reviewText: "An updated review." });
  assert.deepEqual(await publishedReviews(f.db, f.host.id), []);
  assert.equal((await reviewStatistics(f.db, f.host.id)).publishedReviews, 0);
  await assert.rejects(
    () => moderate(f.reviewer, pending.textVersion),
    { code: "INVALID_STATE" },
  );
  const [update] = await f.service.read(f.reviewer, "review-moderation");
  await moderate(f.reviewer, update.textVersion, "HIDDEN");
  assert.equal((await f.own()).review.publicationStatus, "HIDDEN");
  assert.equal((await f.own()).review.privateFeedback, own);
  assert.deepEqual(await publishedReviews(f.db, f.host.id), []);
  const audit = f.db.sqlite
    .prepare("SELECT details FROM mp_audit_events WHERE action='review-publication'")
    .all();
  assert.equal(audit.length, 2);
  assert(!JSON.stringify(audit).includes(written));
});

test("staff review queues paginate old pending entries separately from published takedowns", async (t) => {
  const f = await marketplaceFixture({ hostCount: 1 });
  t.after(() => f.db.close());
  const [host] = f.hosts;
  const booking = f.db.sqlite.prepare(
    `INSERT INTO mp_bookings(id,customer_id,host_id,request_key,fingerprint,
       experience,duration,format,language,quote,amount_cents,currency,
       status,expires_at,created_at,updated_at)
     VALUES(?,?,?,?,'fixture','laugh',15,'video','en','{}',1000,'USD','COMPLETED',?,?,?)`,
  );
  const payment = f.db.sqlite.prepare(
    "INSERT INTO mp_payments VALUES(?,?,?,'CAPTURED',1000,'USD',?,?)",
  );
  const review = f.db.sqlite.prepare(
    "INSERT INTO mp_reviews VALUES(?,?,4,1,'Private test detail',?)",
  );
  const detail = f.db.sqlite.prepare(
    "INSERT INTO mp_review_details VALUES(?,4,'A friendly chat.',?,1)",
  );
  for (const status of ["PENDING", "APPROVED"]) {
    for (let i = 0; i <= 100; i++) {
      const id = status + "-" + i;
      const now = f.clock() + i;
      booking.run(id, f.customer.id, host.id, id, now + 180000, now, now);
      payment.run("payment-" + id, id, "pi_" + id, now, now);
      review.run(id, f.customer.id, now);
      detail.run(id, status);
    }
  }
  let actor = f.reviewer;
  const handle = createMarketplaceHttp({
    contextFor: async () => ({
      db: f.db,
      service: f.service,
      actor,
      config: {},
      clock: f.clock,
    }),
    logger: () => {},
    clock: f.clock,
  });
  const read = (resource, page) =>
    handle(new Request(`https://hc.example.test/api/marketplace?resource=${resource}&page=${page}`));
  const items = async (resource, page) => {
    const response = await read(resource, page);
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };
  const pending = await items("review-moderation", 0);
  assert.equal(pending.length, 100);
  assert(pending.every(({ publicationStatus }) => publicationStatus === "PENDING"));
  assert.equal(pending[0].bookingId, "PENDING-0");
  assert.equal((await items("review-moderation", 1))[0].bookingId, "PENDING-100");
  const published = await items("review-published", 0);
  assert.equal(published.length, 100);
  assert(published.every(({ publicationStatus }) => publicationStatus === "APPROVED"));
  assert.equal(published[0].bookingId, "APPROVED-100");
  assert(!JSON.stringify(published).includes("Private test detail"));
  const [last] = await items("review-published", 1);
  assert.equal(last.bookingId, "APPROVED-0");
  await f.act(f.reviewer, "review-publication", {
    bookingId: last.bookingId,
    textVersion: last.textVersion,
    publicationStatus: "HIDDEN",
  });
  assert.deepEqual(await items("review-published", 1), []);
  assert.equal((await read("review-published", -1)).status, 400);
  assert.equal((await read("review-moderation", 10001)).status, 400);
  actor = await f.user("unstepped-review-staff", ["host_reviewer"]);
  for (const resource of ["review-moderation", "review-published"]) {
    assert.equal((await read(resource, 0)).status, 403);
  }
  actor = f.customer;
  assert.equal((await read("review-published", 0)).status, 403);
});

test("review migration can rerun and retains an unrated comfort dimension on old rows", async (t) => {
  const f = await reviewFixture(t);
  await f.charge("CAPTURED");
  await f.delivery("COMPLETED");
  await f.db
    .prepare("INSERT INTO mp_reviews VALUES(?,?,5,1,'Historical private note',?)")
    .bind(f.booking.id, f.customer.id, f.clock())
    .run();
  f.db.sqlite.exec(
    readFileSync(new URL("../db/marketplace-reviews.sql", import.meta.url), "utf8"),
  );
  const legacy = (await f.own()).review;
  assert.equal(legacy.rating, 5);
  assert.equal(legacy.comfortRating, null);
  assert.equal(legacy.privateFeedback, "Historical private note");
  assert.equal(legacy.reviewText, null);
  const aggregate = await reviewStatistics(f.db, f.host.id);
  assert.equal(aggregate.ratings, 1);
  assert.equal(aggregate.comfortRatings, 0);
});
