import test from "node:test";
import assert from "node:assert/strict";
import { createMarketplaceHttp } from "../lib/marketplace/http-router.mjs";
import { createGuestInvitationHttp } from "../lib/marketplace/guest-invitation-http.mjs";
import { sweepGuestInvitations } from "../lib/marketplace/guest-invitations.mjs";
import { MarketplaceError } from "../lib/marketplace/errors.mjs";
import { marketplaceFixture } from "./marketplace-fixture.mjs";

const origin = "https://test.human-connection.invalid";
const guestTerms = { adult: true, us: true, accepted: true };

async function setup(t) {
  let now = 1800000000000;
  const clock = () => now;
  const f = await marketplaceFixture({ clock });
  t.after(() => f.db.close());
  const host = f.hosts[0];
  const safety = await f.user("guest-safety-fixture", ["safety"], true);
  const unverifiedSafety = await f.user("guest-safety-no-mfa", ["safety"]);
  const { booking } = await f.act(f.customer, "reserve", {
    ...f.choice,
    hostId: host.id,
  });
  const expiresAt = now + 900_000;
  const config = {
    HC_MARKETPLACE_ENABLED: "true",
    MARKETPLACE_MODE: "staging",
    MARKETPLACE_GUEST_INVITATIONS_ENABLED: "true",
    MARKETPLACE_SESSION_SECRET: Buffer.alloc(32, 50).toString("base64"),
  };
  const actorById = new Map([f.customer, host, f.other, f.admin, safety, unverifiedSafety].map((actor) => [actor.id, actor]));
  const memberRoute = createMarketplaceHttp({
    contextFor: async (request) => {
      const actor = actorById.get(request.headers.get("Test-Verified-Actor"));
      if (!actor) throw new MarketplaceError("UNAUTHENTICATED", "Authentication required.", 401);
      return { db: f.db, service: f.service, actor, config, clock };
    },
    logger: () => {},
    clock,
  });
  const guestRoute = createGuestInvitationHttp({ storage: () => ({ db: f.db, config }), clock });
  const command = (actor, action, payload = {}, key = crypto.randomUUID()) =>
    memberRoute(new Request(origin + "/api/marketplace", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        "Test-Verified-Actor": actor.id,
        Origin: origin,
      },
      body: JSON.stringify({ action, payload: { bookingId: booking.id, ...payload } }),
    }));
  const inspect = (actor, resource = "guest-invitation") =>
    memberRoute(new Request(origin + "/api/marketplace?" + new URLSearchParams({
      resource, id: booking.id,
    }), { headers: { "Test-Verified-Actor": actor.id } }));
  const guest = (body, binding = null, source = origin, { edge = false, address } = {}) => {
    const request = new Request(origin + "/api/marketplace/demo-guest", {
      method: body ? "POST" : "GET",
      headers: {
        ...(binding ? { "X-HC-Guest-Scope": binding.scope, Cookie: binding.cookie } : {}),
        ...(body ? { "Content-Type": "application/json", Origin: source } : {}),
        ...(address ? { "CF-Connecting-IP": address } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (edge) Object.defineProperty(request, "cf", { value: { colo: "TEST" } });
    return guestRoute(request);
  };

  function live(payment = "CAPTURED", amount = booking.amount_cents) {
    f.db.sqlite.prepare("UPDATE mp_bookings SET status='LIVE',expires_at=? WHERE id=?").run(expiresAt, booking.id);
    f.db.sqlite.prepare("INSERT INTO mp_payments VALUES(?,?,'pi_fixture',?,?,'USD',?,?)")
      .run("fixture-payment", booking.id, payment, amount, now, now);
  }
  async function issue() {
    assert.equal((await command(f.customer, "guest-invite-request")).status, 200);
    assert.equal((await command(host, "guest-invite-host-approve")).status, 200);
    return (await (await command(f.customer, "guest-invite-issue")).json()).result;
  }
  return { f, host, safety, unverifiedSafety, booking, expiresAt, command, inspect, guest, memberRoute, live, issue, config, advance: (ms) => (now += ms) };
}

async function bindGuest(response) {
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /; Secure; HttpOnly; SameSite=Strict$/);
  const { data } = await response.json();
  assert.deepEqual(Object.keys(data).sort(), ["expiresAt", "scope", "status"]);
  assert.equal(data.status, "GUEST_WAITING");
  assert.ok(cookie.startsWith("__Host-hc-stage-guest-" + data.scope + "="));
  return { scope: data.scope, cookie: cookie.split(";")[0] };
}

test("staging guest waiting and admission require both related accounts and leave media and payments unchanged", async (t) => {
  const s = await setup(t);
  const customer = s.f.customer;
  assert.equal((await s.command(customer, "guest-invite-request")).status, 409);
  s.live();
  assert.equal((await s.inspect(s.f.other)).status, 404);
  assert.equal((await s.inspect(s.f.admin)).status, 404);
  assert.deepEqual((await (await s.inspect(customer)).json()).data, { status: "NOT_REQUESTED", expiresAt: null });
  assert.equal((await s.command(s.host, "guest-invite-request")).status, 403);
  assert.equal((await s.command(customer, "guest-invite-request")).status, 200);
  assert.equal((await s.command(customer, "guest-invite-issue")).status, 409);
  assert.equal((await s.command(customer, "guest-invite-host-approve", { hostId: s.host.id })).status, 403);
  assert.equal((await s.command(s.host, "guest-invite-host-approve")).status, 200);
  assert.equal((await s.command(s.host, "guest-invite-issue")).status, 403);
  const { result } = await (await s.command(customer, "guest-invite-issue")).json();
  const token = result.invitationToken;
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.equal((await s.command(customer, "guest-invite-admit")).status, 409);
  assert.equal((await s.guest({ action: "wait", token, terms: guestTerms }, null, "https://external.invalid")).status, 403);
  assert.equal((await s.guest({ action: "wait", token, terms: { ...guestTerms, accepted: false } })).status, 400);

  const attempts = await Promise.all([
    s.guest({ action: "wait", token, terms: guestTerms }),
    s.guest({ action: "wait", token, terms: guestTerms }),
  ]);
  assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 404]);
  const binding = await bindGuest(attempts.find(({ status }) => status === 200));
  assert.equal((await s.guest(null)).status, 404);
  assert.equal((await s.guest(null, { ...binding, scope: "f".repeat(48) })).status, 404);
  assert.equal((await s.guest({ action: "report", category: "conduct" }, binding)).status, 404);
  assert.equal((await s.command(s.host, "guest-invite-admit")).status, 403);
  const admissions = await Promise.all([
    s.command(customer, "guest-invite-admit"),
    s.command(customer, "guest-invite-admit"),
  ]);
  assert.deepEqual(admissions.map(({ status }) => status).sort(), [200, 409]);
  assert.deepEqual((await (await s.guest(null, binding)).json()).data, {
    status: "GUEST_ADMITTED", expiresAt: result.expiresAt,
  });
  const roomReply = await s.memberRoute(new Request(origin + "/api/marketplace", {
    method: "POST",
    headers: { Cookie: binding.cookie, Origin: origin, "Content-Type": "application/json", "Idempotency-Key": "guest-room" },
    body: JSON.stringify({ action: "room-token", payload: { bookingId: s.booking.id } }),
  }));
  assert.equal(roomReply.status, 401);
  assert.equal((await s.guest({ action: "report", category: "privacy" }, binding)).status, 200);
  assert.equal((await s.inspect(customer, "demo-guest-reports")).status, 403);
  assert.deepEqual((await (await s.inspect(s.f.admin, "demo-guest-reports")).json()).data, [
    { booking_id: s.booking.id, category: "privacy", createdAt: s.f.clock(), status: "OPEN", assignedToMe: false, assignedAt: null, disposition: null, resolvedAt: null },
  ]);
  const inviteRow = s.f.db.sqlite.prepare("SELECT * FROM mp_demo_guest_invitations").get();
  assert(!JSON.stringify(inviteRow).includes(token));
  assert(!JSON.stringify(inviteRow).includes(binding.cookie.split("=")[1]));
  assert.equal(s.f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM mp_video_rooms").get().n, 0);
  assert.deepEqual({...s.f.db.sqlite.prepare("SELECT amount_cents,expires_at FROM mp_bookings WHERE id=?").get(s.booking.id)}, {
    amount_cents: s.booking.amount_cents, expires_at: s.expiresAt,
  });
  assert.equal(s.f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM mp_payments").get().n, 1);
  const leave = await s.guest({ action: "leave" }, binding);
  assert.equal(leave.status, 200);
  assert.match(leave.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await s.guest(null, binding)).status, 404);
});

test("staging unused links rotate, expire, and revoke without admitting a guest", async (t) => {
  const s = await setup(t);
  s.live("CAPTURED", 1);
  assert.equal((await s.command(s.f.customer, "guest-invite-request")).status, 409);
  s.f.db.sqlite.prepare("UPDATE mp_payments SET amount_cents=?").run(s.booking.amount_cents);
  const first = await s.issue();
  s.advance(1000);
  const second = (await (await s.command(s.f.customer, "guest-invite-issue")).json()).result;
  assert.equal(second.expiresAt, first.expiresAt);
  assert.notEqual(second.invitationToken, first.invitationToken);
  assert.equal((await s.guest({ action: "wait", token: first.invitationToken, terms: guestTerms })).status, 404);
  assert.equal((await s.command(s.host, "guest-invite-withdraw")).status, 200);
  assert.equal((await s.guest({ action: "wait", token: second.invitationToken, terms: guestTerms })).status, 404);
  assert.equal((await s.command(s.f.customer, "guest-invite-request")).status, 409);
});

test("staging expiry and room ending cut off guest entry and subsequent guest actions", async (t) => {
  const s = await setup(t);
  s.live();
  const { invitationToken } = await s.issue();
  const binding = await bindGuest(await s.guest({ action: "wait", token: invitationToken, terms: guestTerms }));
  s.advance(180_000);
  assert.equal((await (await s.guest(null, binding)).json()).data.status, "EXPIRED");
  assert.equal((await s.command(s.f.customer, "guest-invite-admit")).status, 409);
  await sweepGuestInvitations(s.f.db, { clock: s.f.clock });
  assert.equal((await (await s.inspect(s.f.customer)).json()).data.status, "EXPIRED");
  const expired = await s.guest(null, binding);
  assert.equal(expired.status, 404);
  assert.match(expired.headers.get("set-cookie"), /Max-Age=0/);
  assertGuestAccessCleared(s);
  s.f.db.sqlite.prepare("UPDATE mp_bookings SET status='COMPLETED' WHERE id=?").run(s.booking.id);
  assert.equal((await (await s.inspect(s.f.customer)).json()).data.status, "SESSION_ENDED");
  assert.equal((await s.guest({ action: "report", category: "conduct" }, binding)).status, 404);
});

test("staging respects both refusals and removes access when the customer expels a guest", async (t) => {
  const refused = await setup(t);
  refused.live();
  await refused.command(refused.f.customer, "guest-invite-request");
  assert.equal((await refused.command(refused.host, "guest-invite-host-decline")).status, 200);
  assert.equal((await refused.command(refused.f.customer, "guest-invite-issue")).status, 409);

  const rejected = await setup(t);
  rejected.live();
  const declinedLink = await rejected.issue();
  const waiting = await bindGuest(await rejected.guest({ action: "wait", token: declinedLink.invitationToken, terms: guestTerms }));
  assert.equal((await rejected.command(rejected.f.customer, "guest-invite-decline")).status, 200);
  assert.equal((await rejected.guest(null, waiting)).status, 404);
  assertGuestAccessCleared(rejected);
  assert.equal((await rejected.command(rejected.f.customer, "guest-invite-admit")).status, 409);

  const removed = await setup(t);
  removed.live();
  const acceptedLink = await removed.issue();
  const admitted = await bindGuest(await removed.guest({ action: "wait", token: acceptedLink.invitationToken, terms: guestTerms }));
  assert.equal((await removed.command(removed.f.customer, "guest-invite-admit")).status, 200);
  assert.equal((await removed.command(removed.f.customer, "guest-invite-remove")).status, 200);
  assert.equal((await removed.guest(null, admitted)).status, 404);
  assertGuestAccessCleared(removed);
  assert.equal((await removed.guest({ action: "report", category: "conduct" }, admitted)).status, 404);
});

function assertGuestAccessCleared(s) {
  const row = s.f.db.sqlite.prepare(
    "SELECT invite_digest,guest_scope,guest_digest,guest_terms_version FROM mp_demo_guest_invitations WHERE booking_id=?",
  ).get(s.booking.id);
  assert.deepEqual({ ...row }, { invite_digest: null, guest_scope: null, guest_digest: null, guest_terms_version: null });
  assert.equal(s.f.db.sqlite.prepare("SELECT COUNT(*) n FROM mp_demo_guest_issue_requests").get().n, 0);
}

test("staging guest entry fails closed without an explicit staging guest flag", async (t) => {
  const s = await setup(t);
  s.live();
  delete s.config.MARKETPLACE_GUEST_INVITATIONS_ENABLED;
  for (const mode of ["staging", "production"]) {
    s.config.MARKETPLACE_MODE = mode;
    assert.equal((await s.inspect(s.f.customer)).status, 503);
    assert.equal((await s.command(s.f.customer, "guest-invite-request")).status, 503);
    assert.equal((await s.guest({ action: "wait", token: "a".repeat(48), terms: guestTerms })).status, 503);
    s.config.MARKETPLACE_GUEST_INVITATIONS_ENABLED = "true";
  }
  assert.equal(s.f.db.sqlite.prepare("SELECT COUNT(*) n FROM mp_demo_guest_claim_quota").get().n, 0);
});

test("issue retries replay the same active link and cannot restore a rotated or claimed link", async (t) => {
  const s = await setup(t);
  s.live();
  await s.command(s.f.customer, "guest-invite-request");
  await s.command(s.host, "guest-invite-host-approve");
  const issue = (key) => s.command(s.f.customer, "guest-invite-issue", {}, key);
  const key = "unique-retry-key";
  const attempts = await Promise.all([issue(key), issue(key)]);
  assert.deepEqual(attempts.map(({ status }) => status), [200, 200]);
  const [first, retry] = await Promise.all(attempts.map(async (response) => (await response.json()).result));
  assert.deepEqual(first, retry);
  const receipts = s.f.db.sqlite.prepare("SELECT * FROM mp_demo_guest_issue_requests").all();
  assert.equal(receipts.length, 1);
  assert(!JSON.stringify(receipts).includes(key));
  assert(!JSON.stringify(receipts).includes(first.invitationToken));
  s.advance(1000);
  const rotated = (await (await issue("distinct-rotation")).json()).result;
  assert.notEqual(rotated.invitationToken, first.invitationToken);
  assert.equal(rotated.expiresAt, first.expiresAt);
  assert.equal((await issue(key)).status, 409);
  assert.equal((await s.guest({ action: "wait", token: rotated.invitationToken, terms: guestTerms })).status, 200);
  assert.equal((await issue("distinct-rotation")).status, 409);
});

test("guest claim quotas persist across clients and discard old buckets", async (t) => {
  const s = await setup(t);
  const invalidClaim = { action: "wait", token: "a".repeat(48), terms: guestTerms };
  const claim = (address, edge) => s.guest(invalidClaim, null, origin, { address, edge });
  for (let attempt = 0; attempt < 12; attempt++)
    assert.equal((await claim("192.0.2.1", true)).status, 404);
  const rejected = await claim("192.0.2.1", true);
  assert.equal(rejected.status, 429);
  assert.equal(rejected.headers.get("retry-after"), "60");
  assert.equal((await claim("192.0.2.2", true)).status, 404);
  for (let attempt = 13; attempt < 120; attempt++)
    assert.equal((await claim("198.51.100.8", false)).status, 404);
  assert.equal((await claim("192.0.2.3", true)).status, 429);
  const buckets = s.f.db.sqlite.prepare("SELECT bucket,count FROM mp_demo_guest_claim_quota").all();
  assert.deepEqual(buckets.map((row) => row.count).sort((a, b) => a - b), [1, 12, 120]);
  assert(!JSON.stringify(buckets).includes("192.0.2."));
  s.advance(180_000);
  await sweepGuestInvitations(s.f.db, { clock: s.f.clock });
  assert.equal(s.f.db.sqlite.prepare("SELECT COUNT(*) n FROM mp_demo_guest_claim_quota").get().n, 0);
  assert.equal((await claim("192.0.2.1", true)).status, 404);
});

test("bound polling, reporting, and leaving have separate quotas without storing the browser binding", async (t) => {
  const s = await setup(t);
  s.live();
  const invitation = await s.issue();
  const binding = await bindGuest(await s.guest({ action: "wait", token: invitation.invitationToken, terms: guestTerms }));
  await s.command(s.f.customer, "guest-invite-admit");

  for (let count = 0; count < 60; count++) assert.equal((await s.guest(null, binding)).status, 200);
  const throttledRead = await s.guest(null, binding);
  assert.equal(throttledRead.status, 429);
  assert.equal(throttledRead.headers.get("retry-after"), "60");
  for (let count = 0; count < 8; count++)
    assert.equal((await s.guest({ action: "report", category: "conduct" }, binding)).status, 200);
  assert.equal((await s.guest({ action: "report", category: "conduct" }, binding)).status, 429);
  assert.equal((await s.guest({ action: "leave" }, binding)).status, 200);
  for (let count = 1; count < 8; count++) assert.equal((await s.guest({ action: "leave" }, binding)).status, 404);
  assert.equal((await s.guest({ action: "leave" }, binding)).status, 429);

  const buckets = s.f.db.sqlite.prepare("SELECT bucket FROM mp_demo_guest_claim_quota").all();
  const serialized = JSON.stringify(buckets);
  assert(!serialized.includes(binding.scope));
  assert(!serialized.includes(binding.cookie.split("=")[1]));
});

test("guest report retries distinguish the original category from a different report", async (t) => {
  const s = await setup(t);
  s.live();
  const invitation = await s.issue();
  const binding = await bindGuest(await s.guest({ action: "wait", token: invitation.invitationToken, terms: guestTerms }));
  await s.command(s.f.customer, "guest-invite-admit");

  const report = (category) => s.guest({ action: "report", category }, binding);
  const first = await report("conduct");
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).data, { submitted: true, replayed: false });
  const retry = await report("conduct");
  assert.equal(retry.status, 200);
  assert.deepEqual((await retry.json()).data, { submitted: true, replayed: true });
  const other = await report("safety");
  assert.equal(other.status, 409);
  assert.equal((await other.json()).error.code, "GUEST_REPORT_EXISTS");
  const queue = await s.inspect(s.safety, "demo-guest-reports");
  assert.equal((await queue.json()).data[0].category, "conduct");
});

test("guest reports stay in a scoped MFA queue and follow the reviewed safety retention policy", async (t) => {
  const s = await setup(t);
  s.live();
  const invitation = await s.issue();
  const binding = await bindGuest(await s.guest({ action: "wait", token: invitation.invitationToken, terms: guestTerms }));
  await s.command(s.f.customer, "guest-invite-admit");
  assert.equal((await s.guest({ action: "report", category: "safety" }, binding)).status, 200);
  s.f.db.sqlite.prepare("UPDATE mp_bookings SET status='COMPLETED' WHERE id=?").run(s.booking.id);
  assertGuestAccessCleared(s);

  s.config.MARKETPLACE_GUEST_INVITATIONS_ENABLED = "false";
  const queue = async (actor) => (await (await s.inspect(actor, "demo-guest-reports")).json()).data;
  const assign = (actor) => s.command(actor, "demo-guest-report-assign");
  const resolve = (actor, disposition) => s.command(actor, "demo-guest-report-resolve", { disposition });
  const policy = { approved: true, safetyRetentionMs: 30_000 };
  assert.equal((await s.inspect(s.unverifiedSafety, "demo-guest-reports")).status, 403);
  assert.equal((await assign(s.unverifiedSafety)).status, 403);
  assert.equal((await assign(s.f.customer)).status, 403);
  assert.equal((await queue(s.safety))[0].status, "OPEN");
  s.advance(40_000);
  await sweepGuestInvitations(s.f.db, { clock: s.f.clock, policy });
  assert.equal((await queue(s.safety))[0].status, "OPEN");
  assert.equal((await resolve(s.safety, "reviewed")).status, 409);
  assert.equal((await assign(s.safety)).status, 200);
  assert.equal((await assign(s.safety)).status, 200);
  assert.equal((await assign(s.f.admin)).status, 409);
  assert.equal((await resolve(s.f.admin, "reviewed")).status, 409);
  assert.equal((await resolve(s.safety, "invalid-detail")).status, 400);
  assert.equal((await resolve(s.safety, "reviewed")).status, 200);
  assert.equal((await resolve(s.safety, "reviewed")).status, 200);
  assert.equal((await resolve(s.safety, "follow-up-required")).status, 409);
  const [resolved] = await queue(s.safety);
  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.assignedToMe, true);
  assert.equal((await queue(s.f.admin))[0].assignedToMe, false);
  assert.equal(resolved.disposition, "reviewed");

  const now = s.f.clock();
  s.f.db.sqlite.prepare(`INSERT INTO mp_privacy_deletions
    (id,user_id,request_key,receipt_hash,status,requested_at,eligible_at,next_attempt_at)
    VALUES('guest-test-deletion',?,'guest-test-deletion','guest-test-receipt','WAITING',?,?,?)`).run(s.host.id, now, now, now);
  s.f.db.sqlite.prepare(`INSERT INTO mp_privacy_holds
    (id,request_id,user_id,scope,reason,status,created_by,created_at,request_key)
    VALUES('guest-test-hold','guest-test-deletion',?,'SAFETY','Fixture safety evidence','ACTIVE',?,?,'guest-test-hold')`).run(s.host.id, s.f.admin.id, now);
  s.advance(31_000);
  await sweepGuestInvitations(s.f.db, { clock: s.f.clock, policy });
  assert.equal((await queue(s.safety)).length, 1);
  s.f.db.sqlite.prepare("UPDATE mp_privacy_holds SET status='RELEASED'").run();
  await sweepGuestInvitations(s.f.db, { clock: s.f.clock });
  assert.equal((await queue(s.safety)).length, 1);
  await sweepGuestInvitations(s.f.db, { clock: s.f.clock, policy });
  assert.deepEqual(await queue(s.safety), []);
  assert.equal(s.f.db.sqlite.prepare("SELECT COUNT(*) n FROM mp_demo_guest_report_triage").get().n, 0);
});
