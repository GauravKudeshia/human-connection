import test from "node:test";
import assert from "node:assert/strict";
import { createMarketplaceHttp } from "../lib/marketplace/http-router.mjs";
import { createGuestInvitationHttp } from "../lib/marketplace/guest-invitation-http.mjs";
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
  const { booking } = await f.act(f.customer, "reserve", {
    ...f.choice,
    hostId: host.id,
  });
  const expiresAt = now + 900_000;
  const config = {};
  const actorById = new Map([f.customer, host, f.other, f.admin].map((actor) => [actor.id, actor]));
  const memberRoute = createMarketplaceHttp({
    contextFor: async (request) => {
      const actor = actorById.get(request.headers.get("Test-Verified-Actor"));
      if (!actor) throw new MarketplaceError("UNAUTHENTICATED", "Authentication required.", 401);
      return { db: f.db, service: f.service, actor, config, clock };
    },
    logger: () => {},
    clock,
  });
  const guestRoute = createGuestInvitationHttp({ storage: () => ({ db: f.db }), clock });
  const command = (actor, action, payload = {}) =>
    memberRoute(new Request(origin + "/api/marketplace", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "Test-Verified-Actor": actor.id,
        Origin: origin,
      },
      body: JSON.stringify({ action, payload: { bookingId: booking.id, ...payload } }),
    }));
  const inspect = (actor, resource = "guest-invitation") =>
    memberRoute(new Request(origin + "/api/marketplace?" + new URLSearchParams({
      resource, id: booking.id,
    }), { headers: { "Test-Verified-Actor": actor.id } }));
  const guest = (body, binding = null, source = origin) =>
    guestRoute(new Request(origin + "/api/marketplace/demo-guest", {
      method: body ? "POST" : "GET",
      headers: {
        ...(binding ? { "X-HC-Guest-Scope": binding.scope, Cookie: binding.cookie } : {}),
        ...(body ? { "Content-Type": "application/json", Origin: source } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));

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
  return { f, host, booking, expiresAt, command, inspect, guest, memberRoute, live, issue, advance: (ms) => (now += ms) };
}

async function bindGuest(response) {
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /; Secure; HttpOnly; SameSite=Strict$/);
  const { data } = await response.json();
  assert.deepEqual(Object.keys(data).sort(), ["expiresAt", "scope", "status"]);
  assert.equal(data.status, "GUEST_WAITING");
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
    { booking_id: s.booking.id, category: "privacy", createdAt: s.f.clock() },
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
  s.f.db.sqlite.prepare("UPDATE mp_bookings SET status='COMPLETED' WHERE id=?").run(s.booking.id);
  assert.equal((await (await s.guest(null, binding)).json()).data.status, "SESSION_ENDED");
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
  assert.equal((await (await rejected.guest(null, waiting)).json()).data.status, "CUSTOMER_DECLINED");
  assert.equal((await rejected.command(rejected.f.customer, "guest-invite-admit")).status, 409);

  const removed = await setup(t);
  removed.live();
  const acceptedLink = await removed.issue();
  const admitted = await bindGuest(await removed.guest({ action: "wait", token: acceptedLink.invitationToken, terms: guestTerms }));
  assert.equal((await removed.command(removed.f.customer, "guest-invite-admit")).status, 200);
  assert.equal((await removed.command(removed.f.customer, "guest-invite-remove")).status, 200);
  assert.equal((await (await removed.guest(null, admitted)).json()).data.status, "GUEST_REMOVED");
  assert.equal((await removed.guest({ action: "report", category: "conduct" }, admitted)).status, 404);
});
