import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sqliteD1 } from "./marketplace-db.mjs";
import { createMarketplace } from "../lib/marketplace/store.mjs";
import {
  createPrivacy,
  privacyPolicyFromConfig,
  assertIdentityAvailable,
} from "../lib/marketplace/privacy.mjs";

const start = 1_800_000_000_000;
const reviewed = {
  approved: true,
  version: "fixture-reviewed-v1",
  deletionDelayMs: 0,
  financialRetentionMs: 0,
  safetyRetentionMs: 0,
  operationalRetentionMs: 0,
  telemetryRetentionMs: 0,
  authenticationRetentionMs: 0,
};
async function fixture({ policy = reviewed, bucket, endSession } = {}) {
  const db = sqliteD1();
  db.sqlite.exec(
    readFileSync(
      new URL("../db/marketplace-privacy.sql", import.meta.url),
      "utf8",
    ),
  );
  let now = start;
  const market = createMarketplace(db, { clock: () => now });
  const user = async (name, role) => {
    const actor = await market.provisionIdentity({
      subject: "provider:" + name,
      displayName: name,
      stepUp: true,
    });
    if (role)
      db.sqlite
        .prepare("INSERT INTO mp_user_roles VALUES(?,?)")
        .run(actor.id, role);
    return actor;
  };
  const customer = await user("customer"),
    host = await user("host", "host"),
    admin = await user("admin", "admin"),
    safety = await user("safety", "safety"),
    stranger = await user("stranger");
  db.sqlite
    .prepare(
      "INSERT INTO mp_host_profiles(user_id,display_name,biography,languages,formats,styles,status,policy_version,training_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      host.id,
      "Host name",
      "Private host biography",
      '["English"]',
      '["audio"]',
      "[]",
      "APPROVED",
      "beta-2026-11",
      "beta-2026-11",
      now,
      now,
    );
  db.sqlite
    .prepare("INSERT INTO mp_host_presence VALUES(?,1,?)")
    .run(host.id, now);
  db.sqlite
    .prepare("INSERT INTO mp_auth_sessions VALUES(?,?,?,?,?)")
    .run("session", "provider:customer", now + 60000, null, now);
  const objects = new Map(),
    deletes = [];
  const defaultBucket = {
    async delete(key) {
      deletes.push(key);
      objects.delete(key);
    },
  };
  const service = createPrivacy(db, {
    authorize: market.authorize,
    clock: () => now,
    policy,
    bucket: bucket || defaultBucket,
    endSession,
  });
  function booking(status = "COMPLETED", paymentStatus) {
    const bookingId = crypto.randomUUID(),
      paymentId = crypto.randomUUID();
    db.sqlite
      .prepare(
        "INSERT INTO mp_bookings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        bookingId,
        customer.id,
        host.id,
        bookingId,
        "fixture",
        "laugh",
        15,
        "audio",
        "English",
        "{}",
        1000,
        "USD",
        status,
        now + 60000,
        now,
        now,
      );
    if (paymentStatus)
      db.sqlite
        .prepare("INSERT INTO mp_payments VALUES(?,?,?,?,?,?,?,?)")
        .run(
          paymentId,
          bookingId,
          "pi_" + paymentId,
          paymentStatus,
          1000,
          "USD",
          now,
          now,
        );
    return { bookingId, paymentId };
  }
  function intro() {
    const introId = crypto.randomUUID(),
      key = "private/" + introId;
    db.sqlite
      .prepare(
        "INSERT INTO mp_intro_media VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        introId,
        host.id,
        key,
        "audio/mp4",
        12,
        "private-checksum",
        "Private transcript",
        now,
        20,
        "APPROVED",
        introId,
        "fixture",
        admin.id,
        "Private reviewer note",
        now,
        now,
      );
    objects.set(key, new Uint8Array([1, 2]));
    return { introId, key };
  }
  function report(status = "OPEN", reporter = customer.id, reported = host.id) {
    const reportId = crypto.randomUUID();
    db.sqlite
      .prepare(
        "INSERT INTO mp_safety_reports VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        reportId,
        reporter,
        reported,
        null,
        "boundaries",
        "STANDARD",
        "Sensitive evidence",
        status,
        null,
        now,
        now,
        reportId,
        "fixture",
      );
    return reportId;
  }
  return {
    db,
    market,
    service,
    customer,
    host,
    admin,
    safety,
    stranger,
    user,
    objects,
    deletes,
    booking,
    intro,
    report,
    tick: (ms) => (now += ms),
    now: () => now,
  };
}

test("account closure revokes access immediately and returns only a hashed private receipt", async (t) => {
  const f = await fixture({ policy: null });
  t.after(() => f.db.close());
  const active = f.booking("REQUESTED");
  f.db.sqlite
    .prepare("INSERT INTO mp_host_claims VALUES(?,?,?,?)")
    .run(f.host.id, f.customer.id, active.bookingId, start + 60000);
  await assert.rejects(
    () => f.service.request(f.customer, {}, "request"),
    (e) => e.code === "CONFIRMATION_REQUIRED",
  );
  await assert.rejects(
    () =>
      f.service.request({ id: f.customer.id }, { confirm: true }, "request"),
    (e) => e.status === 401,
  );
  const result = await f.service.request(
    f.customer,
    { confirm: true },
    "request",
  );
  assert.equal(result.accessClosed, true);
  assert.equal(result.policyVersion, null);
  assert.equal(result.receiptToken.length, 43);
  assert.equal(
    (await f.service.receipt(result.receiptToken)).requestId,
    result.requestId,
  );
  assert.equal(
    "userId" in (await f.service.receipt(result.receiptToken)),
    false,
  );
  assert.notEqual(
    f.db.sqlite.prepare("SELECT receipt_hash FROM mp_privacy_deletions").get()
      .receipt_hash,
    result.receiptToken,
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT revoked_at FROM mp_auth_sessions").get()
      .revoked_at,
    start,
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT status FROM mp_bookings").get().status,
    "CANCELLED",
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_host_claims").get().n,
    0,
  );
  await assert.rejects(
    () => f.market.authorize(f.customer),
    (e) => e.code === "ACCOUNT_UNAVAILABLE",
  );
  await assert.rejects(
    () => assertIdentityAvailable(f.db, "provider:customer"),
    (e) => e.code === "ACCOUNT_UNAVAILABLE",
  );
  assert.equal(
    (await f.service.request(f.customer, { confirm: true }, "request"))
      .replayed,
    true,
  );
  await assert.rejects(
    () => f.service.request(f.customer, { confirm: true }, "different-key"),
    (e) => e.code === "ACCOUNT_UNAVAILABLE",
  );
  assert.deepEqual(await f.service.run(), {
    configured: false,
    scanned: 0,
    erased: 0,
    waiting: 0,
    failed: 0,
  });
  assert.equal(
    f.db.sqlite
      .prepare("SELECT display_name FROM mp_users WHERE id=?")
      .get(f.customer.id).display_name,
    "customer",
  );
});

test("host closure hides availability, purges private media and tombstones identity without deleting financial or policy evidence", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const { bookingId, paymentId } = f.booking("COMPLETED", "CAPTURED");
  const media = f.intro();
  f.db.sqlite
    .prepare("INSERT INTO mp_host_verifications VALUES(?,?,?,?,?,?,?)")
    .run(f.host.id, "VERIFIED", "vs_private", 1, "US", "ELIGIBLE", start);
  f.db.sqlite
    .prepare("INSERT INTO mp_host_verification_evidence VALUES(?,?,?,?,?)")
    .run(f.host.id, "vs_private", "acct_private", f.admin.id, start);
  f.db.sqlite
    .prepare("INSERT INTO mp_ledger_entries VALUES(?,?,?,?,?,?,?,?)")
    .run(
      "ledger",
      bookingId,
      paymentId,
      "capture:fixture",
      "processor_clearing",
      1000,
      0,
      start,
    );
  f.db.sqlite
    .prepare("INSERT INTO mp_reviews VALUES(?,?,?,?,?,?)")
    .run(bookingId, f.customer.id, 5, 1, "Private guest feedback", start);
  const policies = f.db.sqlite
    .prepare("SELECT count(*) n FROM mp_policy_acceptances")
    .get().n;
  const request = await f.service.request(
    f.host,
    { confirm: true },
    "host-close",
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT available FROM mp_host_presence").get()
      .available,
    0,
  );
  const result = await f.service.run();
  assert.equal(result.erased, 1);
  assert.equal(f.objects.size, 0);
  assert.deepEqual(f.deletes, [media.key]);
  assert.equal(
    f.db.sqlite
      .prepare("SELECT provider_subject FROM mp_users WHERE id=?")
      .get(f.host.id).provider_subject,
    "erased:" + f.host.id,
  );
  const intro = f.db.sqlite.prepare("SELECT * FROM mp_intro_media").get();
  assert.equal(intro.transcript, "");
  assert.equal(intro.checksum, "");
  assert.equal(intro.byte_length, 0);
  assert.equal(
    f.db.sqlite.prepare("SELECT private_feedback FROM mp_reviews").get()
      .private_feedback,
    null,
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_ledger_entries").get().n,
    1,
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_policy_acceptances").get().n,
    policies,
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_bookings").get().n,
    1,
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT count(*) n FROM mp_host_verification_evidence")
      .get().n,
    0,
  );
  assert.equal(
    (await f.service.receipt(request.receiptToken)).status,
    "COMPLETED",
  );
  await assert.rejects(
    () => assertIdentityAvailable(f.db, "provider:host"),
    (e) => e.status === 403,
  );
  assert.equal(
    (await f.service.statusForIdentity("provider:host")).status,
    "COMPLETED",
  );
  assert.equal((await f.service.run()).erased, 0);
  assert.throws(
    () => f.db.sqlite.exec("DELETE FROM mp_privacy_events"),
    /append-only/,
  );
  assert.throws(
    () => f.db.sqlite.exec("DELETE FROM mp_ledger_entries"),
    /append-only/,
  );
});

test("reviewed retention snapshots cannot be shortened by a later configuration", async (t) => {
  const f = await fixture({
    policy: {
      ...reviewed,
      version: "older-reviewed-policy",
      deletionDelayMs: 10000,
    },
  });
  t.after(() => f.db.close());
  const request = await f.service.request(
    f.customer,
    { confirm: true },
    "delayed",
  );
  const short = createPrivacy(f.db, {
    authorize: f.market.authorize,
    clock: f.now,
    policy: reviewed,
  });
  assert.equal((await short.run()).waiting, 1);
  assert.equal(
    (await f.service.receipt(request.receiptToken)).eligibleAt,
    start + 10000,
  );
  f.tick(9999);
  assert.equal((await short.run()).erased, 0);
  f.tick(1);
  assert.equal((await short.run()).erased, 1);
  assert.equal(
    (await f.service.receipt(request.receiptToken)).policyVersion,
    "older-reviewed-policy",
  );
});

test("open financial and safety cases hold erasure while customer access stays closed", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const { paymentId } = f.booking("COMPLETED", "PENDING");
  const reportId = f.report();
  await f.service.request(f.customer, { confirm: true }, "close");
  assert.equal((await f.service.run()).waiting, 1);
  assert.equal(
    f.db.sqlite.prepare("SELECT wait_reason FROM mp_privacy_deletions").get()
      .wait_reason,
    "FINANCIAL_RECONCILIATION",
  );
  f.db.sqlite
    .prepare("UPDATE mp_payments SET status='FAILED' WHERE id=?")
    .run(paymentId);
  f.tick(86400000);
  assert.equal((await f.service.run()).waiting, 1);
  assert.equal(
    f.db.sqlite.prepare("SELECT wait_reason FROM mp_privacy_deletions").get()
      .wait_reason,
    "OPEN_SAFETY_CASE",
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT narrative FROM mp_safety_reports").get()
      .narrative,
    "Sensitive evidence",
  );
  f.db.sqlite
    .prepare(
      "UPDATE mp_safety_reports SET status='CLOSED',updated_at=? WHERE id=?",
    )
    .run(f.now(), reportId);
  f.tick(86400000);
  assert.equal((await f.service.run()).erased, 1);
  assert.equal(
    f.db.sqlite.prepare("SELECT narrative FROM mp_safety_reports").get()
      .narrative,
    "Erased under reviewed retention policy",
  );
});

test("only stepped-up administrators place and release idempotent audited retention holds", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const request = await f.service.request(
    f.customer,
    { confirm: true },
    "close",
  );
  const payload = {
    requestId: request.requestId,
    action: "PLACE",
    scope: "ALL",
    reason: "Fictional legal preservation instruction.",
  };
  await assert.rejects(
    () => f.service.hold(f.safety, payload, "hold"),
    (e) => e.status === 403,
  );
  const noMfa = await f.market.provisionIdentity({
    subject: "provider:admin",
    displayName: "admin",
    stepUp: false,
  });
  await assert.rejects(
    () => f.service.hold(noMfa, payload, "hold"),
    (e) => e.code === "STEP_UP_REQUIRED",
  );
  const hold = await f.service.hold(f.admin, payload, "hold");
  assert.equal((await f.service.hold(f.admin, payload, "hold")).replayed, true);
  await assert.rejects(
    () => f.service.hold(f.admin, { ...payload, scope: "SAFETY" }, "hold"),
    (e) => e.code === "KEY_REUSED",
  );
  assert.equal((await f.service.run()).waiting, 1);
  assert.equal((await f.service.queue(f.admin))[0].holds, 1);
  await assert.rejects(
    () => f.service.queue(f.stranger),
    (e) => e.status === 403,
  );
  await f.service.hold(
    f.admin,
    {
      requestId: request.requestId,
      action: "RELEASE",
      holdId: hold.holdId,
      reason: "Fictional hold released.",
    },
    "release",
  );
  assert.equal((await f.service.run()).erased, 1);
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT count(*) n FROM mp_privacy_events WHERE action LIKE 'hold-%'",
      )
      .get().n,
    2,
  );
});

test("media cleanup retries safely and stale workers cannot redact data after their lease expires", async (t) => {
  const f = await fixture({
    bucket: {
      async delete() {
        throw new Error("SECRET PROVIDER RESPONSE");
      },
    },
  });
  t.after(() => f.db.close());
  f.intro();
  const request = await f.service.request(f.host, { confirm: true }, "close");
  assert.equal((await f.service.run()).failed, 1);
  const failed = f.db.sqlite
    .prepare("SELECT * FROM mp_privacy_deletions")
    .get();
  assert.equal(failed.wait_reason, "CLEANUP_RETRY");
  assert.equal(failed.status, "WAITING");
  assert.equal(
    JSON.stringify(
      f.db.sqlite.prepare("SELECT * FROM mp_privacy_events").all(),
    ).includes("SECRET"),
    false,
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT display_name FROM mp_users WHERE id=?")
      .get(f.host.id).display_name,
    "host",
  );
  f.tick(2000);
  const expiring = createPrivacy(f.db, {
    authorize: f.market.authorize,
    clock: f.now,
    policy: reviewed,
    bucket: {
      async delete() {
        f.tick(60001);
      },
    },
  });
  assert.equal((await expiring.run()).erased, 0);
  assert.equal(
    f.db.sqlite
      .prepare("SELECT display_name FROM mp_users WHERE id=?")
      .get(f.host.id).display_name,
    "host",
  );
  const working = createPrivacy(f.db, {
    authorize: f.market.authorize,
    clock: f.now,
    policy: reviewed,
    bucket: {
      async delete(key) {
        f.objects.delete(key);
      },
    },
  });
  assert.equal((await working.run()).erased, 1);
  assert.equal(
    (await working.receipt(request.receiptToken)).status,
    "COMPLETED",
  );
});

test("concurrent scheduled privacy runs use one lease and perform one object cleanup", async (t) => {
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const f = await fixture({
    bucket: {
      async delete() {
        calls++;
        entered();
        await gate;
      },
    },
  });
  t.after(() => f.db.close());
  f.intro();
  const request = await f.service.request(f.host, { confirm: true }, "close");
  const first = f.service.run();
  await started;
  const second = await f.service.run();
  assert.equal(second.erased, 0);
  await assert.rejects(
    () =>
      f.service.hold(
        f.admin,
        {
          requestId: request.requestId,
          action: "PLACE",
          scope: "ALL",
          reason: "Hold race.",
        },
        "late-hold",
      ),
    (e) => e.code === "PURGE_IN_PROGRESS",
  );
  release();
  assert.equal((await first).erased, 1);
  assert.equal(calls, 1);
});

test("concurrent closure retries create one request, one subject block and one audit event", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      f.service.request(f.customer, { confirm: true }, "same-key"),
    ),
  );
  assert.equal(new Set(results.map((row) => row.requestId)).size, 1);
  assert.equal(results.filter((row) => !!row.receiptToken).length, 1);
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_privacy_deletions").get().n,
    1,
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT count(*) n FROM mp_privacy_subject_blocks")
      .get().n,
    1,
  );
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT count(*) n FROM mp_privacy_events WHERE action='account-closed'",
      )
      .get().n,
    1,
  );
});

test("active sessions must end through trusted session service and staff require handoff", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  f.booking("LIVE", "CAPTURED");
  await assert.rejects(
    () => f.service.request(f.customer, { confirm: true }, "live"),
    (e) => e.code === "ACTIVE_SESSION",
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT status FROM mp_users WHERE id=?")
      .get(f.customer.id).status,
    "ACTIVE",
  );
  await assert.rejects(
    () => f.service.request(f.admin, { confirm: true }, "admin"),
    (e) => e.code === "STAFF_HANDOFF_REQUIRED",
  );
  const ended = [];
  const service = createPrivacy(f.db, {
    authorize: f.market.authorize,
    clock: f.now,
    policy: reviewed,
    endSession: async (actor, id) => {
      ended.push({ actor: actor.id, id });
      f.db.sqlite
        .prepare("UPDATE mp_bookings SET status='PARTIAL_DELIVERY' WHERE id=?")
        .run(id);
    },
  });
  await service.request(f.customer, { confirm: true }, "ended");
  assert.equal(ended.length, 1);
  assert.equal(
    f.db.sqlite
      .prepare("SELECT status FROM mp_users WHERE id=?")
      .get(f.customer.id).status,
    "CLOSED",
  );
});

test("retention configuration fails closed and global expiry preserves held account telemetry", async (t) => {
  assert.equal(privacyPolicyFromConfig({}), null);
  const config = {
    MARKETPLACE_PRIVACY_PURGE_ENABLED: "true",
    MARKETPLACE_PRIVACY_REVIEWED_VERSION: "reviewed-v1",
  };
  for (const name of [
    "DELETION_DELAY",
    "FINANCIAL_RETENTION",
    "SAFETY_RETENTION",
    "OPERATIONAL_RETENTION",
    "TELEMETRY_RETENTION",
    "AUTHENTICATION_RETENTION",
  ])
    config["MARKETPLACE_PRIVACY_" + name + "_DAYS"] = "1";
  assert.equal(privacyPolicyFromConfig(config).financialRetentionMs, 86400000);
  assert.equal(
    privacyPolicyFromConfig({
      ...config,
      MARKETPLACE_PRIVACY_TELEMETRY_RETENTION_DAYS: "-1",
    }),
    null,
  );
  assert.equal(
    privacyPolicyFromConfig({
      ...config,
      MARKETPLACE_PRIVACY_PURGE_ENABLED: "false",
    }),
    null,
  );
  const f = await fixture();
  t.after(() => f.db.close());
  f.db.sqlite
    .prepare("INSERT INTO mp_analytics_events VALUES(?,?,?,?,?,?,?)")
    .run(
      "event-a",
      f.customer.id,
      "experience_selected",
      null,
      "laugh",
      start - 1,
      "key-a",
    );
  f.db.sqlite
    .prepare("INSERT INTO mp_analytics_events VALUES(?,?,?,?,?,?,?)")
    .run(
      "event-b",
      f.stranger.id,
      "experience_selected",
      null,
      "laugh",
      start - 1,
      "key-b",
    );
  const request = await f.service.request(
    f.customer,
    { confirm: true },
    "close",
  );
  await f.service.hold(
    f.admin,
    {
      requestId: request.requestId,
      action: "PLACE",
      scope: "ALL",
      reason: "Retain telemetry evidence.",
    },
    "hold",
  );
  const result = await f.service.sweepExpired();
  assert.equal(result.configured, true);
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_analytics_events").get().n,
    1,
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT user_id FROM mp_analytics_events").get()
      .user_id,
    f.customer.id,
  );
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT count(*) n FROM mp_auth_sessions WHERE subject='provider:customer'",
      )
      .get().n,
    1,
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT count(*) n FROM mp_privacy_retention_runs")
      .get().n,
    1,
  );
});

test("photos, host drafts and account-linked analytics erase under the same lease and pending uploads wait", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  for (const migration of [
    "marketplace-experience.sql",
    "marketplace-analytics.sql",
  ])
    f.db.sqlite.exec(
      readFileSync(new URL("../db/" + migration, import.meta.url), "utf8"),
    );
  f.db.sqlite
    .prepare("INSERT INTO mp_host_drafts VALUES(?,?,?)")
    .run(
      f.host.id,
      JSON.stringify({ biography: "Private unfinished draft" }),
      start,
    );
  f.db.sqlite
    .prepare("INSERT INTO mp_request_limits VALUES(?,?,?,?)")
    .run(f.host.id, "upload", start, 2);
  f.db.sqlite
    .prepare(
      "INSERT INTO mp_profile_photos VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "photo",
      f.host.id,
      "private/photo",
      "image/jpeg",
      12,
      "Private photo description",
      start,
      "UPLOADING",
      null,
      null,
      start,
      start,
      "photo-key",
      "fixture",
    );
  f.objects.set("private/photo", new Uint8Array([3]));
  await f.service.request(f.host, { confirm: true }, "close");
  assert.equal((await f.service.run()).waiting, 1);
  assert.equal(
    f.db.sqlite.prepare("SELECT wait_reason FROM mp_privacy_deletions").get()
      .wait_reason,
    "MEDIA_UPLOAD_IN_PROGRESS",
  );
  f.db.sqlite.prepare("UPDATE mp_profile_photos SET status='FAILED'").run();
  f.tick(60000);
  assert.equal((await f.service.run()).erased, 1);
  assert.equal(f.objects.size, 0);
  const photo = f.db.sqlite.prepare("SELECT * FROM mp_profile_photos").get();
  assert.equal(photo.object_key, "erased/photo");
  assert.equal(photo.alt_text, "");
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_host_drafts").get().n,
    0,
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT count(*) n FROM mp_request_limits").get().n,
    0,
  );
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT count(*) n FROM mp_availability_observations WHERE host_id=?",
      )
      .get(f.host.id).n,
    0,
  );
});

test("unresolved connected-account transfers hold erasure and financial retention starts after reconciliation", async (t) => {
  const f = await fixture({
    policy: { ...reviewed, financialRetentionMs: 5000 },
  });
  t.after(() => f.db.close());
  f.db.sqlite.exec(
    readFileSync(
      new URL("../db/marketplace-commercial.sql", import.meta.url),
      "utf8",
    ),
  );
  f.db.sqlite
    .prepare(
      "INSERT INTO mp_payout_batches(id,host_id,destination_reference,currency,amount_cents,status,requested_by,request_key,fingerprint,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "transfer",
      f.host.id,
      "acct_private",
      "USD",
      700,
      "SUBMITTED",
      f.admin.id,
      "transfer",
      "fixture",
      start,
      start,
      start,
    );
  await f.service.request(f.host, { confirm: true }, "close");
  assert.equal((await f.service.run()).waiting, 1);
  assert.equal(
    f.db.sqlite.prepare("SELECT wait_reason FROM mp_privacy_deletions").get()
      .wait_reason,
    "FINANCIAL_RECONCILIATION",
  );
  f.tick(86400000);
  f.db.sqlite
    .prepare("UPDATE mp_payout_batches SET status='RECONCILED',updated_at=?")
    .run(f.now());
  assert.equal((await f.service.run()).waiting, 1);
  assert.equal(
    f.db.sqlite.prepare("SELECT eligible_at FROM mp_privacy_deletions").get()
      .eligible_at,
    f.now() + 5000,
  );
  f.tick(5000);
  assert.equal((await f.service.run()).erased, 1);
  assert.equal(
    f.db.sqlite
      .prepare("SELECT destination_reference FROM mp_payout_batches")
      .get().destination_reference,
    "acct_private",
  );
});

test("provisioning cannot recreate a purged identity when closure wins between lookup and insert", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const original = f.db.batch.bind(f.db);
  f.db.batch = async (statements) => {
    f.db.batch = original;
    await f.service.request(f.customer, { confirm: true }, "closure-race");
    assert.equal((await f.service.run()).erased, 1);
    return original(statements);
  };
  await assert.rejects(
    () =>
      f.market.provisionIdentity({
        subject: "provider:customer",
        displayName: "Recreated",
        stepUp: true,
      }),
    (error) => error.code === "ACCOUNT_UNAVAILABLE",
  );
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT count(*) n FROM mp_users WHERE provider_subject='provider:customer'",
      )
      .get().n,
    0,
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT count(*) n FROM mp_users WHERE display_name='Recreated'")
      .get().n,
    0,
  );
});
test("closure retries atomically when a pending payment becomes READY after the active-session snapshot", async (t) => {
  let f;
  const ended = [];
  f = await fixture({
    endSession: async (actor, id) => {
      ended.push(id);
      f.db.sqlite
        .prepare("UPDATE mp_bookings SET status='FAILED_SERVICE' WHERE id=?")
        .run(id);
    },
  });
  t.after(() => f.db.close());
  const { bookingId } = f.booking("ACCEPTED", "PENDING");
  const original = f.db.batch.bind(f.db);
  let injected = false;
  f.db.batch = async (statements) => {
    if (!injected) {
      injected = true;
      f.db.sqlite
        .prepare("UPDATE mp_bookings SET status='READY' WHERE id=?")
        .run(bookingId);
      f.db.sqlite
        .prepare("UPDATE mp_payments SET status='CAPTURED' WHERE booking_id=?")
        .run(bookingId);
    }
    return original(statements);
  };
  const request = await f.service.request(
    f.customer,
    { confirm: true },
    "capture-race",
  );
  assert.equal(request.accessClosed, true);
  assert.deepEqual(ended, [bookingId]);
  assert.equal(
    f.db.sqlite
      .prepare("SELECT status FROM mp_users WHERE id=?")
      .get(f.customer.id).status,
    "CLOSED",
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT COUNT(*) n FROM mp_privacy_deletions").get().n,
    1,
  );
});
