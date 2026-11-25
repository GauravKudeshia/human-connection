import test from "node:test";
import assert from "node:assert/strict";
import { createDailyTestProvider, verifyDailyWebhook } from "../lib/marketplace/providers.mjs";
import { createGuestInvitations } from "../lib/marketplace/guest-invitations.mjs";
import { createSessionService } from "../lib/marketplace/sessions.mjs";
import { marketplaceFixture } from "./marketplace-fixture.mjs";

const now = 1_800_000_000_000;
const expiry = now + 15 * 60_000;
const guestSigningSecret = Buffer.alloc(32, 91).toString("base64");

test("Daily installs and recovers only rooms whose response confirms the pair capacity and policy", async () => {
  for (const [change, collision] of [
    [{}, false],
    [{}, true],
    [{ max_participants: 3 }, false],
    [{ max_participants: 3 }, true],
    [{ exp: expiry / 1000 + 1 }, true],
    [{ enforce_unique_user_ids: false }, true],
    [{ eject_at_room_exp: false }, true],
    [{ enable_knocking: true }, true],
    [{ enable_transcription_storage: true }, false],
  ]) {
    const calls = [];
    let policy;
    const provider = createDailyTestProvider({
      apiKey: "local-unused-fixture",
      allowTestRooms: true,
      fetcher: async (url, init) => {
        calls.push([url, init.method]);
        if (init.method === "POST") {
          policy = JSON.parse(init.body).properties;
          if (collision) return Response.json({ error: "room exists" }, { status: 409 });
        }
        return Response.json({
          name: "hc-test-fixture-booking",
          privacy: "private",
          url: "https://fixture.daily.co/hc-test-fixture-booking",
          config: { ...policy, ...change },
        });
      },
    });
    const provision = () => provider.createRoom({
      bookingId: "fixture-booking", expiresAt: expiry, format: "video",
    }, now);
    if (Object.keys(change).length)
      await assert.rejects(provision, { code: "ROOM_POLICY_MISMATCH", status: 502 });
    else
      assert.equal((await provision()).config.max_participants, 2);
    assert.deepEqual(calls, [
      ["https://api.daily.co/v1/rooms", "POST"],
      ...(collision ? [["https://api.daily.co/v1/rooms/hc-test-fixture-booking", "GET"]] : []),
    ]);
  }
});

test("a dual-approved preview guest cannot mint a room grant or enter paid attendance", async (t) => {
  const clock = () => now;
  const { db, act, customer, other, hosts: [host], choice } = await marketplaceFixture({ clock });
  t.after(() => db.close());
  const { booking } = await act(customer, "reserve", { ...choice, hostId: host.id });
  const roomName = "hc-test-" + booking.id;
  const joinDeadline = now + 3 * 60_000;
  await db.batch([
    db.prepare("UPDATE mp_bookings SET status='READY',expires_at=? WHERE id=?").bind(joinDeadline, booking.id),
    db.prepare("UPDATE mp_host_claims SET expires_at=? WHERE booking_id=?").bind(joinDeadline, booking.id),
    db.prepare("INSERT INTO mp_payments VALUES('fixture-payment',?,'pi_fixture','CAPTURED',1000,'USD',?,?)")
      .bind(booking.id, now, now),
  ]);
  let grants = 0;
  const sessions = createSessionService(db, {
    clock,
    videoProvider: {
      async createRoom() {
        return {
          name: roomName,
          url: "https://fixture.daily.co/" + roomName,
          privacy: "private",
        };
      },
      async participantToken() {
        grants++;
        return { token: "local-pair-fixture" };
      },
    },
  });
  const secret = Buffer.alloc(32, 19);
  const stamp = String(now / 1000);
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  async function signedAttendance(actor) {
    const raw = JSON.stringify({
      id: "fixture-provider-" + actor.id,
      type: "participant.joined",
      event_ts: now / 1000,
      payload: {
        room: roomName,
        user_id: actor.id,
        session_id: "fixture-session-" + actor.id,
        joined_at: now / 1000,
      },
    });
    const signature = Buffer.from(await crypto.subtle.sign(
      "HMAC", key, new TextEncoder().encode(stamp + "." + raw),
    )).toString("base64");
    return verifyDailyWebhook(raw, signature, stamp, secret.toString("base64"), now);
  }
  for (const actor of [host, customer]) {
    assert.ok((await sessions.roomToken(actor, booking.id)).token);
    await sessions.ingest(await signedAttendance(actor));
  }
  const before = await sessions.read(customer, booking.id);
  assert.equal(before.status, "LIVE");
  assert.equal(before.startedAt, now);
  assert.equal(before.deadline, expiry);
  assert.equal(before.attendance.length, 2);
  const payment = await db.prepare("SELECT amount_cents AS amount,status FROM mp_payments").first();
  const ledger = await db.prepare("SELECT COUNT(*) AS n FROM mp_ledger_entries").first();

  const invitations = createGuestInvitations(db, { clock, signingSecret: guestSigningSecret });
  await invitations.act(customer, "guest-invite-request", booking.id);
  await invitations.act(host, "guest-invite-host-approve", booking.id);
  const { invitationToken } = await invitations.act(customer, "guest-invite-issue", booking.id, "fixture-issue");
  const claim = await invitations.claim(invitationToken, { adult: true, us: true, accepted: true });
  await invitations.act(customer, "guest-invite-admit", booking.id);
  assert.equal((await invitations.guestState(claim.data.scope, claim.binding)).status, "GUEST_ADMITTED");

  await assert.rejects(() => sessions.roomToken(other, booking.id), { code: "NOT_FOUND" });
  assert.equal(grants, 2);
  const signedGuestEvent = await signedAttendance(other);
  await assert.rejects(() => sessions.ingest(signedGuestEvent), { code: "UNEXPECTED_PARTICIPANT" });
  assert.deepEqual(await sessions.read(customer, booking.id), before);
  assert.deepEqual(await db.prepare("SELECT amount_cents AS amount,status FROM mp_payments").first(), payment);
  assert.deepEqual(await db.prepare("SELECT COUNT(*) AS n FROM mp_ledger_entries").first(), ledger);
});
