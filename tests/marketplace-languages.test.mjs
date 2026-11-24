import assert from "node:assert/strict";
import test from "node:test";
import {
  languageName,
  normalizeHostLanguages,
  normalizeLanguageTag,
} from "../lib/conversation-languages.mjs";
import { fingerprint } from "../lib/fingerprint.mjs";
import { createExperienceService } from "../lib/marketplace/experience.mjs";
import { createMarketplaceHttp } from "../lib/marketplace/http-router.mjs";
import { marketplaceFixture } from "./marketplace-fixture.mjs";

const settings = {
  displayName: "Fictional language host",
  biography: "Test fixture only",
  formats: ["video"],
  styles: ["just-listen"],
  adult: true,
  policyVersion: "beta-2026-11",
  trainingVersion: "beta-2026-11",
};

test("host languages normalize aliases, dialect tags, duplicate choices and proficiency", () => {
  assert.deepEqual(normalizeHostLanguages([
    "English",
    { tag: "EN", proficiency: "fluent" },
    { tag: "es-mx", proficiency: "bilingual" },
    "ES-MX",
    "bn",
  ]), [
    { tag: "en", proficiency: "fluent" },
    { tag: "es-MX", proficiency: "bilingual" },
    { tag: "bn", proficiency: null },
  ]);
  for (const bad of ["", "hi_IN", "garbage", "en-u-ca-buddhist", "und", "'"]) {
    assert.equal(normalizeLanguageTag(bad), null);
  }
  assert.equal(normalizeHostLanguages([{ tag: "hi", proficiency: "invented" }]), null);
  assert.equal(normalizeHostLanguages([{ tag: "hi", proficiency: ["fluent"] }]), null);
});

test("approved language supply remains visible offline and filters use live matching eligibility", async (t) => {
  const f = await marketplaceFixture({ hostCount: 0 });
  t.after(() => f.db.close());
  const host = await f.user("hindi-test-host");
  const list = (values = {}) => f.service.read(f.customer, "languages", null, {
    experience: "hear", format: "video", ...values,
  });
  await assert.rejects(
    () => f.act(host, "host-submit", { ...settings, languages: ["hi_IN"] }),
    { code: "VALIDATION" },
  );
  const experience = createExperienceService(f.db, {
    service: f.service, authorize: f.service.authorize, clock: f.clock,
  });
  await experience.saveDraft(host, {
    languages: ["English", { tag: "HI", proficiency: "fluent" }, "hi"],
  });
  assert.deepEqual((await experience.draft(host)).languages, [
    { tag: "en", proficiency: null },
    { tag: "hi", proficiency: "fluent" },
  ]);
  await f.act(host, "host-submit", {
    ...settings,
    languages: ["English", { tag: "HI", proficiency: "fluent" }, "hi"],
  });
  assert.deepEqual(await list(), []);
  await f.db.prepare(
    "INSERT INTO mp_host_verifications VALUES(?,'VERIFIED','fixture-hi',1,'US','ELIGIBLE',?)",
  ).bind(host.id, f.clock()).run();
  await f.act(f.reviewer, "host-review", {
    hostId: host.id, status: "APPROVED", reason: "Local fixture",
  });
  assert.deepEqual(await list(), []);
  await f.act(f.reviewer, "certify", {
    hostId: host.id, experience: "hear", status: "APPROVED",
    rubric: "Local fixture", expiresAt: f.clock() + 3_600_000,
  });
  assert.deepEqual(await list(), [
    { tag: "en", label: "English", availableNow: false },
    { tag: "hi", label: "Hindi", availableNow: false },
  ]);
  assert.deepEqual(await list({ format: "audio" }), []);
  assert.deepEqual(await list({ experience: "distract" }), []);
  const choice = { ...f.choice, experience: "hear", style: "just-listen", language: "HI" };
  assert.deepEqual(await f.service.read(f.customer, "hosts", null, choice), []);
  await f.act(host, "heartbeat", { available: true });
  const response = await createMarketplaceHttp({
    contextFor: async () => ({ db: f.db, actor: f.customer, service: f.service, clock: f.clock, config: {} }),
    logger: () => {},
    clock: f.clock,
  })(new Request("https://staging.example/api/marketplace?resource=languages&experience=hear&format=video"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, [
    { tag: "en", label: "English", availableNow: true },
    { tag: "hi", label: "Hindi", availableNow: true },
  ]);
  assert.deepEqual((await f.service.read(f.customer, "hosts", null, choice)).map((row) => row.user_id), [host.id]);
  const { booking } = await f.act(f.customer, "reserve", choice, "hindi-booking");
  assert.equal(booking.language, "hi");
  assert.equal(booking.quote.language, "hi");
  assert.equal((await list()).find(({ tag }) => tag === "hi").availableNow, false);
  const { booking: accepted } = await f.act(host, "accept", { bookingId: booking.id });
  assert.equal(JSON.parse(accepted.quote).language, "hi");
  await f.act(f.customer, "cancel", { bookingId: booking.id });

  await assert.rejects(
    () => f.act(f.other, "host-languages", { hostId: host.id, languages: ["en"] }),
    { code: "FORBIDDEN" },
  );
  await f.act(host, "host-languages", { languages: [{ tag: "bn", proficiency: "bilingual" }] });
  assert.deepEqual(await list(), [{ tag: "bn", label: languageName("bn"), availableNow: true }]);
  await f.act(f.reviewer, "host-review", { hostId: host.id, status: "REJECTED", reason: "Fixture only" });
  assert.deepEqual(await list(), []);
  await f.act(f.reviewer, "host-review", { hostId: host.id, status: "APPROVED", reason: "Fixture only" });
  assert.equal((await list()).length, 1);
  await f.act(f.reviewer, "host-review", { hostId: host.id, status: "SUSPENDED", reason: "Fixture only" });
  assert.deepEqual(await list(), []);
  await assert.rejects(
    () => f.act(host, "host-languages", { languages: ["en"] }),
    { code: "FORBIDDEN" },
  );
});

test("legacy language strings and reservation fingerprints remain valid", async (t) => {
  const f = await marketplaceFixture({ hostCount: 1 });
  t.after(() => f.db.close());
  await f.db.prepare("UPDATE mp_host_profiles SET languages=? WHERE user_id=?")
    .bind('["English","Spanish"]', f.hosts[0].id).run();
  const discover = await f.service.read(f.customer, "languages");
  assert.deepEqual(discover.map(({ tag }) => tag), ["en", "es"]);
  assert.equal((await f.service.read(f.customer, "hosts", null, { ...f.choice, language: "ES" })).length, 1);
  const key = "stored-before-language-update";
  const { experience, duration, format, style } = f.choice;
  const digest = fingerprint(JSON.stringify({ experience, duration, format, language: "English", style, hostId: null }));
  await f.db.prepare(
    `INSERT INTO mp_bookings(id,customer_id,host_id,request_key,fingerprint,experience,duration,
          format,language,quote,amount_cents,currency,status,expires_at,created_at,updated_at)
      VALUES('legacy-language',?,?,?,?,?,15,'video','English','{}',1000,'USD','EXPIRED',?,?,?)`,
  ).bind(f.customer.id, f.hosts[0].id, key, digest, experience, f.clock(), f.clock(), f.clock()).run();
  const replay = await f.act(f.customer, "reserve", { ...f.choice, language: "en" }, key);
  assert.equal(replay.replayed, true);
  assert.equal(replay.booking.language, "English");
  await assert.rejects(
    () => f.act(f.customer, "reserve", { ...f.choice, language: "es" }, key),
    { code: "KEY_REUSED" },
  );
});
