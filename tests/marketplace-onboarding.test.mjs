import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sqliteD1 } from "./marketplace-db.mjs";
import { createMarketplace } from "../lib/marketplace/store.mjs";
import {
  createOnboarding,
  createStripeVerificationLookup,
  CURRENT_POLICY,
} from "../lib/marketplace/onboarding.mjs";
const start = 1_800_000_000_000;
async function fixture() {
  const db = sqliteD1();
  db.sqlite.exec(
    readFileSync(
      new URL("../db/marketplace-operations.sql", import.meta.url),
      "utf8",
    ),
  );
  const market = createMarketplace(db, { clock: () => start });
  const user = async (name, role) => {
    const actor = await market.provisionIdentity({
      subject: name,
      displayName: name,
      stepUp: true,
    });
    if (role)
      await db
        .prepare("INSERT INTO mp_user_roles VALUES(?,?)")
        .bind(actor.id, role)
        .run();
    return actor;
  };
  const customer = await user("customer"),
    host = await user("host"),
    reviewer = await user("reviewer", "host_reviewer"),
    stranger = await user("stranger");
  await market.act(
    host,
    "host-submit",
    {
      displayName: "Fictional audition",
      biography: "Test-only host",
      adult: true,
      policyVersion: CURRENT_POLICY,
      trainingVersion: CURRENT_POLICY,
      languages: ["English"],
      formats: ["audio"],
      styles: ["funny-stories"],
    },
    crypto.randomUUID(),
  );
  const objects = new Map();
  const bucket = {
    async put(key, bytes) {
      objects.set(key, bytes);
    },
    async get(key) {
      return objects.has(key) ? { body: objects.get(key) } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  const provider = {
    async lookup({ identityReference, hostId }) {
      return {
        reference: identityReference,
        hostId,
        status: "VERIFIED",
        adult: true,
        country: "US",
        payoutEligible: true,
      };
    },
  };
  const service = createOnboarding(db, {
    clock: () => start,
    bucket,
    authorize: market.authorize,
    verificationProvider: provider,
  });
  const media = {
    bytes: new Uint8Array([0, 0, 0, 0, 102, 116, 121, 112, 109, 112, 52, 50]),
    contentType: "audio/mp4",
    transcript: "A fictional authorized host introduction.",
    consent: true,
    durationSeconds: 20,
  };
  return {
    db,
    market,
    customer,
    host,
    reviewer,
    stranger,
    objects,
    bucket,
    service,
    media,
  };
}
test("customer eligibility requires current adult U.S. acknowledgement and persists versioned acceptance", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  assert.equal(
    (await f.service.read(f.customer, "eligibility")).eligible,
    false,
  );
  await assert.rejects(
    () =>
      f.service.act(f.customer, "customer-eligibility", {
        adult: true,
        us: false,
        accepted: true,
        policyVersion: CURRENT_POLICY,
      }),
    (e) => e.status === 400,
  );
  const p = {
    adult: true,
    us: true,
    accepted: true,
    policyVersion: CURRENT_POLICY,
  };
  await f.service.act(f.customer, "customer-eligibility", p);
  await f.service.act(f.customer, "customer-eligibility", p);
  assert.equal(
    (await f.service.read(f.customer, "eligibility")).eligible,
    true,
  );
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT count(*) n FROM mp_policy_acceptances WHERE kind='customer'",
      )
      .get().n,
    1,
  );
  await assert.rejects(
    () =>
      f.service.read({ id: f.customer.id, roles: ["admin"] }, "eligibility"),
    (e) => e.status === 401,
  );
});
test("intro media remains private until independent moderation and preserves accessible transcript", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const uploaded = await f.service.uploadIntro(f.host, f.media, "upload");
  assert.equal(uploaded.status, "PENDING");
  assert.equal(
    (await f.service.uploadIntro(f.host, f.media, "upload")).introId,
    uploaded.introId,
  );
  await assert.rejects(
    () => f.service.media(f.stranger, uploaded.introId),
    (e) => e.status === 403,
  );
  assert.equal(
    (await f.service.media(f.reviewer, uploaded.introId)).transcript,
    f.media.transcript,
  );
  await assert.rejects(
    () =>
      f.service.act(f.reviewer, "host-intro-review", {
        introId: uploaded.introId,
        decision: "APPROVED",
        reason: "Reviewed.",
      }),
    (e) => e.status === 400,
  );
  await f.service.act(f.reviewer, "host-intro-review", {
    introId: uploaded.introId,
    decision: "APPROVED",
    durationConfirmed: true,
    reason: "Reviewed the authorized twenty-second clip.",
  });
  f.db.sqlite.prepare("UPDATE mp_host_profiles SET status='APPROVED'").run();
  assert.equal(
    (await f.service.media(f.stranger, uploaded.introId)).byteLength,
    12,
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT intro_reference FROM mp_host_profiles").get()
      .intro_reference,
    uploaded.introId,
  );
  await assert.rejects(() =>
    f.service.act(f.reviewer, "host-intro-review", {
      introId: uploaded.introId,
      decision: "REJECTED",
      reason: "Second decision.",
    }),
  );
});
test("upload validates size, content signature, consent and replay payload before storing", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  for (const change of [
    { consent: false },
    { bytes: new Uint8Array(12) },
    { durationSeconds: 31 },
    { contentType: "text/html" },
    { bytes: new Uint8Array(8 * 1024 * 1024 + 1) },
  ])
    await assert.rejects(() =>
      f.service.uploadIntro(
        f.host,
        { ...f.media, ...change },
        crypto.randomUUID(),
      ),
    );
  await f.service.uploadIntro(f.host, f.media, "upload");
  await assert.rejects(
    () =>
      f.service.uploadIntro(
        f.host,
        { ...f.media, transcript: "Changed" },
        "upload",
      ),
    (e) => e.code === "KEY_REUSED",
  );
  assert.equal(f.objects.size, 1);
});
test("upload failure keeps a failed private record and removes the object", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const service = createOnboarding(f.db, {
    clock: () => start,
    authorize: f.market.authorize,
    bucket: {
      ...f.bucket,
      async put() {
        throw new Error("Provider outage");
      },
    },
  });
  await assert.rejects(
    () => service.uploadIntro(f.host, f.media, "failed"),
    (e) => e.code === "UPLOAD_FAILED",
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_intro_media").get().status,
    "FAILED",
  );
  assert.equal(f.objects.size, 0);
});
test("verification requires trusted provider evidence and stores references without identity attributes", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await assert.rejects(
    () =>
      f.service.act(f.host, "host-verification-review", {
        hostId: f.host.id,
        identityReference: "vs_fixture",
        payoutReference: "acct_fixture",
      }),
    (e) => e.status === 403,
  );
  const absent = createOnboarding(f.db, { authorize: f.market.authorize });
  await assert.rejects(
    () =>
      absent.act(f.reviewer, "host-verification-review", { hostId: f.host.id }),
    (e) => e.status === 503,
  );
  await f.service.act(f.reviewer, "host-verification-review", {
    hostId: f.host.id,
    identityReference: "vs_fixture",
    payoutReference: "acct_fixture",
    adult: false,
    status: "REJECTED",
  });
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_host_verifications").get()
      .status,
    "VERIFIED",
  );
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT count(*) n FROM pragma_table_info('mp_host_verification_evidence') WHERE name LIKE '%dob%'",
      )
      .get().n,
    0,
  );
});
test("appeal replay is stable and approval returns a suspended host to review", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  f.db.sqlite.prepare("UPDATE mp_host_profiles SET status='SUSPENDED'").run();
  const first = await f.service.act(
    f.host,
    "host-appeal",
    { reason: "Fictional appeal." },
    "appeal",
  );
  assert.equal(
    (
      await f.service.act(
        f.host,
        "host-appeal",
        { reason: "Fictional appeal." },
        "appeal",
      )
    ).appealId,
    first.appealId,
  );
  await assert.rejects(
    () =>
      f.service.act(f.host, "appeal-decision", {
        appealId: first.appealId,
        decision: "APPROVED",
        reason: "Self approval.",
      }),
    (e) => e.status === 403,
  );
  await f.service.act(f.reviewer, "appeal-decision", {
    appealId: first.appealId,
    decision: "APPROVED",
    reason: "Return for a fresh audition.",
  });
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_host_profiles").get().status,
    "REVIEW_PENDING",
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT count(*) n FROM mp_user_roles WHERE role='host'")
      .get().n,
    0,
  );
});
test("Stripe verification lookup binds both provider references to the reviewed host and drops raw data", async () => {
  const provider = createStripeVerificationLookup({
    secretKey: "sk_test_fixture",
    clock: () => start,
    fetcher: async (url) =>
      Response.json(
        url.includes("verification_sessions")
          ? {
              id: "vs_fixture",
              livemode: false,
              status: "verified",
              metadata: { hc_user_id: "host" },
              verified_outputs: {
                dob: { year: 1990, month: 1, day: 1 },
                address: { country: "US" },
                first_name: "Private",
                id_number: "do-not-store",
              },
            }
          : {
              id: "acct_fixture",
              country: "US",
              payouts_enabled: true,
              details_submitted: true,
              metadata: { hc_user_id: "host" },
              requirements: { disabled_reason: null },
            },
      ),
  });
  const result = await provider.lookup({
    identityReference: "vs_fixture",
    payoutReference: "acct_fixture",
    hostId: "host",
  });
  assert.equal(result.adult, true);
  assert.equal(result.payoutEligible, true);
  assert.equal(JSON.stringify(result).includes("Private"), false);
  await assert.rejects(
    () =>
      provider.lookup({
        identityReference: "vs_fixture",
        payoutReference: "acct_fixture",
        hostId: "other",
      }),
    (e) => e.code === "VERIFICATION_OWNER_MISMATCH",
  );
});

test("concurrent introduction uploads enforce the moderation queue bound atomically", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) =>
      f.service.uploadIntro(f.host, f.media, "parallel-" + i),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(f.objects.size, 3);
  assert.equal(
    f.db.sqlite
      .prepare("SELECT count(*) n FROM mp_intro_media WHERE status='PENDING'")
      .get().n,
    3,
  );
});
test("concurrent retry of one upload stores a single private object", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      f.service.uploadIntro(f.host, f.media, "parallel-retry"),
    ),
  );
  assert.ok(results.some((r) => r.status === "fulfilled"));
  assert.equal(f.objects.size, 1);
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_intro_media").get().n,
    1,
  );
});
