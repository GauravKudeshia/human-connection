import test from "node:test";
import assert from "node:assert/strict";
import { marketplaceFixture } from "./marketplace-fixture.mjs";
import {
  createExperienceService,
  sanitizeProfilePng,
} from "../lib/marketplace/experience.mjs";
const png = () =>
  Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
    ),
    (c) => c.charCodeAt(0),
  );
function experience(f, bucket) {
  return createExperienceService(f.db, {
    authorize: f.service.authorize,
    service: f.service,
    clock: f.clock,
    bucket,
  });
}
test("replacement reuses server preferences, excludes declined host, retries once and never starts payment", async (t) => {
  const f = await marketplaceFixture();
  t.after(() => f.db.close());
  const x = experience(f);
  const first = await f.act(f.customer, "reserve", {
    ...f.choice,
    hostId: f.hosts[0].id,
  });
  await f.act(f.hosts[0], "decline", { bookingId: first.booking.id });
  const next = await x.replace(f.customer, first.booking.id),
    replay = await x.replace(f.customer, first.booking.id);
  assert.equal(next.booking.host_id, f.hosts[1].id);
  assert.equal(next.booking.id, replay.booking.id);
  assert.equal(next.booking.quote.style, f.choice.style);
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM mp_payments").first()).n,
    0,
  );
  await assert.rejects(
    () => x.replace(f.other, first.booking.id),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => x.replace(f.customer, next.booking.id),
    (e) => e.code === "INVALID_STATE",
  );
});
test("replacement fails safely with no eligible alternative or a started payment", async (t) => {
  const f = await marketplaceFixture({ hostCount: 1 });
  t.after(() => f.db.close());
  const x = experience(f);
  const first = await f.act(f.customer, "reserve", {
    ...f.choice,
    hostId: f.hosts[0].id,
  });
  await f.act(f.hosts[0], "decline", { bookingId: first.booking.id });
  await assert.rejects(
    () => x.replace(f.customer, first.booking.id),
    (e) => e.code === "NO_MATCH",
  );
  await f.db
    .prepare(
      "INSERT INTO mp_payments VALUES('payment',?,'pi_fixture','PENDING',1000,'USD',?,?)",
    )
    .bind(first.booking.id, f.clock(), f.clock())
    .run();
  await assert.rejects(
    () => x.replace(f.customer, first.booking.id),
    (e) => e.code === "PAYMENT_REVIEW_REQUIRED",
  );
});
test("matching prefers an eligible favourite without weakening block, approval or claim checks", async (t) => {
  const f = await marketplaceFixture();
  t.after(() => f.db.close());
  await f.act(f.customer, "favourite", { hostId: f.hosts[1].id, saved: true });
  const result = await f.act(f.customer, "reserve", f.choice);
  assert.equal(result.booking.host_id, f.hosts[1].id);
  await f.act(f.customer, "cancel", { bookingId: result.booking.id });
  await f.act(f.customer, "block", { userId: f.hosts[1].id });
  const next = await f.act(f.customer, "reserve", f.choice);
  assert.equal(next.booking.host_id, f.hosts[0].id);
});
test("host quality and profiles use delivered eligible feedback only and hide private notes", async (t) => {
  const f = await marketplaceFixture();
  t.after(() => f.db.close());
  const x = experience(f);
  const booking = (
    await f.act(f.customer, "reserve", { ...f.choice, hostId: f.hosts[0].id })
  ).booking;
  await f.db
    .prepare("UPDATE mp_bookings SET status='COMPLETED' WHERE id=?")
    .bind(booking.id)
    .run();
  await f.act(f.customer, "review", {
    bookingId: booking.id,
    rating: 5,
    worthIt: true,
    privateFeedback: "private test note",
  });
  const hosts = await f.service.read(f.customer, "hosts", null, f.choice),
    profiles = await x.profiles(f.customer, hosts);
  const stats = await x.quality(f.hosts[0]);
  assert.equal(stats.delivered, 1);
  assert.equal(stats.ratings, 1);
  assert.equal(stats.valueYes, 1);
  assert(!JSON.stringify(stats).includes("private test note"));
  assert.equal(
    profiles.find((h) => h.user_id === f.hosts[0].id)?.statistics.averageRating,
    5,
  );
  await assert.rejects(
    () => x.quality(f.customer, f.hosts[0].id),
    (e) => e.status === 403,
  );
});
test("drafts preserve application choices without granting host eligibility", async (t) => {
  const f = await marketplaceFixture();
  t.after(() => f.db.close());
  const x = experience(f);
  await x.saveDraft(f.other, {
    displayName: "Test draft",
    formats: ["audio"],
    styles: ["funny-stories"],
  });
  assert.equal((await x.draft(f.other)).displayName, "Test draft");
  assert.equal(await x.draft(f.customer), null);
  assert.equal(await f.service.read(f.other, "application"), null);
  await assert.rejects(
    () => x.saveDraft(f.hosts[0], { displayName: "Changed" }),
    (e) => e.code === "INVALID_STATE",
  );
});
test("profile photo validates PNG, consent, review and visibility; repeated uploads are bounded", async (t) => {
  const f = await marketplaceFixture();
  t.after(() => f.db.close());
  const objects = new Map();
  const bucket = {
    async put(k, v) {
      objects.set(k, v);
    },
    async get(k) {
      const b = objects.get(k);
      return b ? { body: b } : null;
    },
  };
  const x = experience(f, bucket);
  const bytes = png();
  // Fixture PNG CRCs are verified independently by the upload parser.
  const sanitized = sanitizeProfilePng(bytes);
  assert(sanitized.length <= bytes.length);
  await assert.rejects(
    () =>
      x.uploadPhoto(
        f.hosts[0],
        { bytes, altText: "Test portrait", consent: false },
        "photo",
      ),
    (e) => e.code === "CONSENT_REQUIRED",
  );
  const photo = await x.uploadPhoto(
    f.hosts[0],
    { bytes, altText: "Test portrait", consent: true },
    "photo",
  );
  assert.equal(
    (
      await x.uploadPhoto(
        f.hosts[0],
        { bytes, altText: "Test portrait", consent: true },
        "photo",
      )
    ).photoId,
    photo.photoId,
  );
  await assert.rejects(
    () => x.photo(f.customer, photo.photoId),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () =>
      x.photoReview(f.customer, {
        photoId: photo.photoId,
        status: "APPROVED",
        reason: "Test",
      }),
    (e) => e.status === 403,
  );
  await x.photoReview(f.reviewer, {
    photoId: photo.photoId,
    status: "APPROVED",
    reason: "Fixture reviewed",
  });
  assert.equal(
    (await x.photo(f.customer, photo.photoId)).contentType,
    "image/png",
  );
  await f.act(f.customer, "reserve", { ...f.choice, hostId: f.hosts[0].id });
  await f.act(f.customer, "block", { userId: f.hosts[0].id });
  await assert.rejects(
    () => x.photo(f.customer, photo.photoId),
    (e) => e.status === 404,
  );
  const bad = bytes.slice();
  bad[20] ^= 1;
  assert.throws(() => sanitizeProfilePng(bad));
  assert.throws(() => sanitizeProfilePng(new TextEncoder().encode("<svg/>")));
});
