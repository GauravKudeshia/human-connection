import test from "node:test";
import assert from "node:assert/strict";
import { createGuestInvitationHttp } from "../lib/marketplace/guest-invitation-http.mjs";
import { createGuestInvitations } from "../lib/marketplace/guest-invitations.mjs";
import { marketplaceFixture } from "./marketplace-fixture.mjs";

const origin = "https://test.human-connection.invalid";
const terms = { adult: true, us: true, accepted: true };
const proof = "a".repeat(48);
const secondBrowserProof = "b".repeat(48);

async function fixture(t) {
  let now = 1_800_000_000_000;
  const clock = () => now;
  const { db, customer, hosts, act, choice } = await marketplaceFixture({ clock, hostCount: 1 });
  t.after(() => db.close());
  const host = hosts[0];
  const { booking } = await act(customer, "reserve", { ...choice, hostId: host.id });
  db.sqlite.prepare("UPDATE mp_bookings SET status='LIVE',expires_at=? WHERE id=?").run(now + 900_000, booking.id);
  db.sqlite.prepare("INSERT INTO mp_payments VALUES(?,?,'pi_fixture',?,?,'USD',?,?)")
    .run("fixture-payment", booking.id, "CAPTURED", booking.amount_cents, now, now);
  const config = {
    HC_MARKETPLACE_ENABLED: "true",
    MARKETPLACE_MODE: "staging",
    MARKETPLACE_GUEST_INVITATIONS_ENABLED: "true",
    MARKETPLACE_SESSION_SECRET: Buffer.alloc(32, 50).toString("base64"),
  };
  const invitations = createGuestInvitations(db, { clock, signingSecret: config.MARKETPLACE_SESSION_SECRET });
  await invitations.act(customer, "guest-invite-request", booking.id);
  await invitations.act(host, "guest-invite-host-approve", booking.id);
  const issued = await invitations.act(customer, "guest-invite-issue", booking.id, "fixture-issue");
  const route = createGuestInvitationHttp({ storage: () => ({ db, config }), clock });
  function guest(body, scope, cookie, resource) {
    const url = new URL("/api/marketplace/demo-guest", origin);
    if (resource) url.searchParams.set("resource", resource);
    return route(new Request(url, {
      method: body ? "POST" : "GET",
      headers: {
        ...(body ? { Origin: origin, "Content-Type": "application/json" } : {}),
        ...(scope ? { "X-HC-Guest-Scope": scope } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
  }
  const claim = (retryProof, consent = terms) => guest({ action: "wait", token: issued.invitationToken, retryProof, terms: consent });
  const memberAction = (action) => invitations.act(customer, "guest-invite-" + action, booking.id);
  return { db, claim, guest, token: issued.invitationToken, memberAction, advance: (ms) => (now += ms) };
}

const cookiePair = (value) => value.split(";", 1)[0];

test("an interrupted claim can be recovered without a cookie using the originating browser proof", async (t) => {
  const s = await fixture(t);
  const originalResponse = await s.claim(proof);
  assert.equal(originalResponse.status, 200);
  const original = (await originalResponse.json()).data;
  const [originalRoomCookie] = originalResponse.headers.getSetCookie();

  // Neither this second browser nor a retry without its local proof has received a credential.
  assert.equal((await s.claim(secondBrowserProof)).status, 404);
  assert.equal((await s.claim()).status, 404);
  assert.equal((await s.claim("too-short")).status, 400);
  assert.equal((await s.claim(proof, { ...terms, accepted: false })).status, 400);

  const recovered = await s.claim(proof);
  assert.equal(recovered.status, 200);
  assert.deepEqual((await recovered.json()).data, original);
  const [roomCookie, reportCookie] = recovered.headers.getSetCookie();
  assert.equal(roomCookie, originalRoomCookie);
  assert.match(roomCookie, /Max-Age=900; Secure; HttpOnly; SameSite=Strict$/);
  assert.match(reportCookie, /Max-Age=4500; Secure; HttpOnly; SameSite=Strict$/);
  const stored = s.db.sqlite.prepare("SELECT guest_scope,guest_digest,invite_digest FROM mp_demo_guest_invitations").get();
  assert.match(stored.guest_scope, /^[0-9a-f]{64}$/);
  assert.match(stored.guest_digest, /^[0-9a-f]{64}$/);
  assert.equal(stored.invite_digest, null);
  const persisted = JSON.stringify(stored);
  for (const secret of [s.token, proof, original.scope, cookiePair(roomCookie).split("=")[1]]) {
    assert(!persisted.includes(secret));
  }
  const state = await s.guest(null, original.scope, cookiePair(roomCookie));
  assert.equal((await state.json()).data.status, "GUEST_WAITING");
  const reportAsRoom = cookiePair(roomCookie).split("=")[0] + "=" + cookiePair(reportCookie).split("=")[1];
  assert.equal((await s.guest(null, original.scope, reportAsRoom)).status, 404);
});

test("the same proof converges during simultaneous retries and does not extend invitation expiry", async (t) => {
  const s = await fixture(t);
  const attempts = await Promise.all([s.claim(proof), s.claim(proof)]);
  assert.deepEqual(attempts.map(({ status }) => status), [200, 200]);
  const [first, second] = await Promise.all(attempts.map(async (body) => (await body.json()).data));
  assert.deepEqual(first, second);
  assert.equal((await s.claim(secondBrowserProof)).status, 404);

  await s.memberAction("admit");
  s.advance(15_000);
  const admitted = await s.claim(proof);
  assert.deepEqual((await admitted.json()).data, { ...first, status: "GUEST_ADMITTED" });
  assert.match(admitted.headers.getSetCookie()[0], /Max-Age=885;/);
  assert.match(admitted.headers.getSetCookie()[1], /Max-Age=4485;/);
  s.advance(165_000);
  assert.equal((await s.claim(proof)).status, 404);
  assert.equal((await s.guest(null, first.scope, cookiePair(admitted.headers.getSetCookie()[0]))).status, 200);
});

test("room revocation prevents recovery and existing legacy scopes can still leave", async (t) => {
  const s = await fixture(t);
  const claimed = await s.claim(proof);
  const { scope } = (await claimed.json()).data;
  const [roomCookie] = claimed.headers.getSetCookie();
  s.db.sqlite.prepare("UPDATE mp_demo_guest_invitations SET guest_scope=?").run(scope);
  assert.equal((await s.guest(null, scope, cookiePair(roomCookie))).status, 200);
  assert.equal((await s.guest({ action: "leave" }, scope, cookiePair(roomCookie))).status, 200);
  assert.equal((await s.claim(proof)).status, 404);
  assert.equal((await s.guest(null, scope, cookiePair(roomCookie))).status, 404);
});

test("only the report credential preserves reporting after departure, up to its original deadline", async (t) => {
  const s = await fixture(t);
  const reply = await s.claim(proof);
  const { scope } = (await reply.json()).data;
  const [roomCookie, reportCookie] = reply.headers.getSetCookie().map(cookiePair);
  const reportStatus = (cookie) => s.guest(null, scope, cookie, "report-status");
  const beforeAdmission = await reportStatus(reportCookie);
  assert.equal(beforeAdmission.status, 404);
  assert.equal(beforeAdmission.headers.get("set-cookie"), null);

  await s.memberAction("admit");
  assert.equal((await reportStatus(reportCookie)).status, 200);
  assert.equal((await s.guest({ action: "leave" }, scope, roomCookie)).status, 200);
  assert.equal((await s.guest(null, scope, reportCookie)).status, 404);
  assert.equal((await reportStatus(roomCookie)).status, 404);
  assert.equal((await s.guest({ action: "report", category: "privacy" }, scope, roomCookie)).status, 404);
  const grace = await reportStatus(reportCookie);
  assert.deepEqual((await grace.json()).data, { canReport: true, expiresAt: 1_800_004_500_000 });
  const report = await s.guest({ action: "report", category: "privacy" }, scope, reportCookie);
  assert.deepEqual((await report.json()).data, { submitted: true, replayed: false });

  s.advance(4_500_000);
  const expired = await reportStatus(reportCookie);
  assert.equal(expired.status, 404);
  assert.match(expired.headers.get("set-cookie"), /Max-Age=0;/);
});
