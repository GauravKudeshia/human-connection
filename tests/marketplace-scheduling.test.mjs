import assert from "node:assert/strict";
import test from "node:test";
import { marketplaceFixture } from "./marketplace-fixture.mjs";
import { createScheduling, resolveLocalScheduleTime } from "../lib/marketplace/scheduling.mjs";
import { createMarketplaceHttp } from "../lib/marketplace/http-router.mjs";
import { BETA_PRICE_POLICY, quoteFor } from "../lib/marketplace/pricing.mjs";

const start = Date.parse("2026-11-24T15:00:00Z");
const hostWindow = { startsLocal: "2026-11-24T10:00", endsLocal: "2026-11-24T12:00", timeZone: "America/New_York" };
const selectSlot = (choice, slot) => ({
  ...choice,
  slotId: slot.id,
  expectedPriceCents: slot.priceCents,
  expectedCurrency: slot.currency,
});

async function setup(t, { initialNow = start - 60 * 60_000, ...options } = {}) {
  let now = initialNow;
  const clock = () => now;
  const data = await marketplaceFixture({ clock, ...options });
  t.after(() => data.db.close());
  return {
    ...data,
    schedule: createScheduling(data.db, {
      clock, authorize: data.service.authorize, service: data.service, quoteFor: options.quoteFor,
    }),
    time: (value) => { now = value; },
  };
}

test("schedule input rejects a DST gap and explicitly distinguishes both occurrences of a repeated time", () => {
  const zone = "America/New_York";
  assert.throws(() => resolveLocalScheduleTime("2026-03-08T02:30", zone), /move forward/);
  assert.throws(() => resolveLocalScheduleTime("2026-11-01T01:30", zone), /occurs twice/);
  const earlier = resolveLocalScheduleTime("2026-11-01T01:30", zone, "earlier");
  const later = resolveLocalScheduleTime("2026-11-01T01:30", zone, "later");
  assert.equal(earlier.at, Date.parse("2026-11-01T05:30:00Z"));
  assert.equal(later.at, Date.parse("2026-11-01T06:30:00Z"));
  assert.equal(resolveLocalScheduleTime("2026-11-24T20:45", "Asia/Kathmandu").at, start);
  assert.throws(() => resolveLocalScheduleTime("2026-02-29T10:00", zone), /valid local date/);
});

test("scoped future slots work through the authenticated router without a live host or payment", async (t) => {
  const { db, service, clock, hosts: [host], customer, other, choice, act } = await setup(t);
  const origin = "https://marketplace.test";
  function router(actor) {
    return createMarketplaceHttp({
      contextFor: async () => ({ actor, db, service, clock, config: {} }),
      logger: () => {},
      clock,
    });
  }
  async function post(actor, action, payload, key = crypto.randomUUID()) {
    const response = await router(actor)(new Request(origin + "/api/marketplace", {
      method: "POST",
      headers: { origin, "Content-Type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ action, payload }),
    }));
    return [response.status, await response.json()];
  }
  const slotUrl = origin + "/api/marketplace?" + new URLSearchParams({ resource: "schedule-slots", ...choice, hostId: host.id });
  await act(host, "heartbeat", { available: false });
  assert.equal((await post(customer, "schedule-block-save", hostWindow))[0], 403);
  const [savedStatus, saved] = await post(host, "schedule-block-save", hostWindow, "host-block");
  assert.equal(savedStatus, 200, JSON.stringify(saved));
  assert.deepEqual((await post(host, "schedule-block-save", hostWindow, "host-block"))[1].result, saved.result);
  assert.equal((await post(host, "schedule-block-save", { ...hostWindow, endsLocal: "2026-11-24T13:00" }))[0], 409);
  const firstSlot = (await (await router(customer)(new Request(slotUrl))).json()).data.slots[0];
  assert.equal(firstSlot.startsAt, start);
  assert.equal(firstSlot.endsAt, start + 15 * 60_000);
  assert.equal(firstSlot.hostId, host.id);
  assert.equal(firstSlot.priceCents, 1000);
  const [reserveStatus, reserved] = await post(customer, "schedule-reserve", { ...selectSlot(choice, firstSlot), priceCents: 1 }, "reserve-1");
  assert.equal(reserveStatus, 200, JSON.stringify(reserved));
  const reservation = reserved.result.reservation;
  assert.equal(reservation.status, "SCHEDULED");
  assert.equal(reservation.priceCents, 1000);
  assert.equal(reservation.bookingId, null);
  assert.equal(reservation.checkInFrom, start);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM mp_payments").first()).n, 0);
  assert.equal((await post(other, "schedule-cancel", { reservationId: reservation.id }))[0], 404);
  assert.equal((await post(customer, "schedule-check-in", { reservationId: reservation.id }))[1].error.code, "SCHEDULE_CHECK_IN_CLOSED");
  assert.equal((await post(host, "schedule-block-remove", saved.result))[1].error.code, "SCHEDULE_RESERVED");
  assert.deepEqual((await post(customer, "schedule-reserve", selectSlot(choice, firstSlot), "reserve-1"))[1].result, reserved.result);
  assert.equal((await post(customer, "schedule-reserve", { ...selectSlot(choice, firstSlot), format: "audio" }, "reserve-1"))[1].error.code, "KEY_REUSED");
  assert.equal((await post(host, "schedule-cancel", { reservationId: reservation.id }))[1].result.reservation.status, "CANCELLED");
  assert.equal((await post(host, "schedule-block-remove", saved.result))[0], 200);
});

test("a scheduled-only profile returns approved public fields for eligible choices and denies blocked hosts", async (t) => {
  const { db, service, schedule, clock, hosts: [host], customer, choice, act } = await setup(t);
  await act(host, "heartbeat", { available: false });
  const read = createMarketplaceHttp({
    contextFor: async () => ({ actor: customer, db, service, clock, config: {} }),
    logger: () => {},
    clock,
  });
  const profile = (preferences = choice) => read(new Request(
    "https://marketplace.test/api/marketplace?" + new URLSearchParams({
      resource: "scheduled-host-profile", id: host.id, ...preferences,
    }),
  ));
  assert.equal((await profile()).status, 404);
  await schedule.act(host, "schedule-block-save", hostWindow, "profile-window");
  await db.prepare("INSERT INTO mp_host_interests VALUES(?,?) ON CONFLICT(host_id) DO UPDATE SET interests=excluded.interests")
    .bind(host.id, JSON.stringify(["Photography"]))
    .run();
  for (const status of ["APPROVED", "PENDING"]) {
    await db.prepare(
      `INSERT INTO mp_intro_media(id,host_id,object_key,content_type,byte_length,checksum,transcript,
       consent_at,duration_seconds,status,request_key,fingerprint,created_at,updated_at)
       VALUES(?,?,?,'audio/mp4',12,'private-checksum',?,?,20,?,?,'fixture',?,?)`,
    ).bind(status, host.id, "private/" + status, status + " transcript", clock(), status, status, clock(), clock()).run();
  }
  const response = await profile();
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.user_id, host.id);
  assert.equal(data.identityVerified, true);
  assert.deepEqual(JSON.parse(data.interests), ["Photography"]);
  assert.equal(data.intro.transcript, "APPROVED transcript");
  assert.equal(data.statistics.publishedReviews, 0);
  assert.doesNotMatch(JSON.stringify(data), /private\/|private-checksum|PENDING/);
  assert.equal((await profile({ ...choice, language: "hi" })).status, 404);
  await db.prepare("INSERT INTO mp_blocks VALUES(?,?,?)")
    .bind(host.id, customer.id, clock())
    .run();
  assert.equal((await profile()).status, 404);
});

test("overlapping future requests serialize for both roles and near-term immediate requests respect the hold", async (t) => {
  const { schedule, hosts: [host, anotherHost], customer, other, choice, time, act, service } = await setup(t);
  await schedule.act(host, "schedule-block-save", hostWindow, "block-1");
  await schedule.act(anotherHost, "schedule-block-save", hostWindow, "block-2");
  const cursor = async (forCustomer, forHost, index = 0) =>
    (await schedule.read(forCustomer, "schedule-slots", null, { ...choice, hostId: forHost.id })).slots[index];
  const firstSlot = await cursor(customer, host);
  const overlapping = await cursor(other, host, 1);
  const overlappingCustomer = await cursor(customer, anotherHost);
  const contenders = await Promise.allSettled([
    schedule.act(customer, "schedule-reserve", selectSlot(choice, firstSlot), "future-1"),
    schedule.act(other, "schedule-reserve", selectSlot(choice, overlapping), "future-2"),
  ]);
  assert.equal(contenders.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(contenders[1].reason.code, "SCHEDULE_UNAVAILABLE");
  await assert.rejects(
    () => schedule.act(customer, "schedule-reserve", selectSlot(choice, overlappingCustomer), "future-3"),
    { code: "SCHEDULE_UNAVAILABLE" },
  );
  time(start - 12 * 60_000);
  await act(host, "heartbeat", { available: true });
  await assert.rejects(() => act(other, "reserve", { ...choice, hostId: host.id }), { code: "NO_MATCH" });
  const languages = await service.read(other, "languages", null, { ...choice, hostId: host.id });
  assert.equal(languages.find(({ tag }) => tag === "en").availableNow, false);
  const open = await schedule.read(other, "schedule-slots", null, { ...choice, hostId: host.id });
  assert.ok(open.slots.length > 0);
  assert.ok(open.slots.every((slot) => slot.startsAt >= start + 30 * 60_000));
});

test("scheduled check-in creates one existing unpaid booking and expires no-shows", async (t) => {
  const { schedule, hosts: [host, alternate], customer, other, choice, time, clock, act, service, db } = await setup(t);
  await schedule.act(host, "schedule-block-save", hostWindow, "block");
  const offered = (await schedule.read(customer, "schedule-slots", null, { ...choice, hostId: host.id })).slots;
  const held = (await schedule.act(customer, "schedule-reserve", selectSlot(choice, offered[0]), "scheduled-1")).reservation;
  const missed = (await schedule.act(other, "schedule-reserve", selectSlot(choice, offered[2]), "scheduled-2")).reservation;
  time(start);
  await act(host, "heartbeat", { available: false });
  await assert.rejects(() => schedule.act(customer, "schedule-check-in", { reservationId: held.id }), { code: "SCHEDULE_HOST_NOT_READY" });
  await act(host, "heartbeat", { available: true });
  await assert.rejects(() => act(customer, "reserve", choice, "schedule-check-in:" + held.id), { code: "VALIDATION" });
  await assert.rejects(() => schedule.act(other, "schedule-check-in", { reservationId: held.id }), { code: "NOT_FOUND" });
  const [first, duplicate] = await Promise.all([
    schedule.act(customer, "schedule-check-in", { reservationId: held.id }),
    schedule.act(customer, "schedule-check-in", { reservationId: held.id }),
  ]);
  assert.equal(first.booking.id, duplicate.booking.id);
  assert.equal(first.booking.status, "REQUESTED");
  assert.equal(first.booking.expires_at, clock() + 30_000);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM mp_bookings").first()).n, 1);
  const hostRow = (await schedule.read(host, "scheduled-reservations", "host")).reservations.find((row) => row.id === held.id);
  assert.equal(hostRow.status, "CHECKED_IN");
  assert.equal(hostRow.bookingId, first.booking.id);
  await act(alternate, "heartbeat", { available: true });
  await assert.rejects(() => act(host, "reserve", { ...choice, hostId: alternate.id }), { code: "NO_MATCH" });
  await act(host, "accept", { bookingId: first.booking.id });
  const accepted = await service.read(customer, "booking", first.booking.id);
  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(accepted.quote.totalCents, 1000);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM mp_payments").first()).n, 0);
  time(missed.checkInUntil);
  await assert.rejects(() => schedule.act(other, "schedule-check-in", { reservationId: missed.id }), { code: "SCHEDULE_CHECK_IN_CLOSED" });
  assert.equal((await schedule.read(other, "scheduled-reservations")).reservations[0].status, "EXPIRED");
});

test("an immediate and scheduled request cannot take the same host window at once", async (t) => {
  const { schedule, hosts: [host], customer, other, choice, time, act, db } = await setup(t);
  await schedule.act(host, "schedule-block-save", hostWindow, "block");
  time(start - 10 * 60_000);
  await act(host, "heartbeat", { available: true });
  const { slots } = await schedule.read(customer, "schedule-slots", null, { ...choice, hostId: host.id });
  assert.equal(slots[0].startsAt, start);
  const contenders = await Promise.allSettled([
    act(other, "reserve", { ...choice, hostId: host.id }),
    schedule.act(customer, "schedule-reserve", selectSlot(choice, slots[0]), "planned-race"),
  ]);
  assert.equal(contenders.filter((result) => result.status === "fulfilled").length, 1);
  const { n } = await db.prepare(
    "SELECT (SELECT COUNT(*) FROM mp_host_claims) + (SELECT COUNT(*) FROM mp_scheduled_reservations) AS n",
  ).first();
  assert.equal(n, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM mp_payments").first()).n, 0);
});

test("check-in rejects a changed price without charging and freezes the verified price through acceptance", async (t) => {
  let priceCents = 1000;
  const { schedule, hosts: [host], customer, choice, time, act, service, db } = await setup(t, {
    quoteFor: (input) => quoteFor(input, {
      ...BETA_PRICE_POLICY,
      prices: { 15: priceCents, 30: 1800 },
    }),
  });
  await schedule.act(host, "schedule-block-save", hostWindow, "block");
  const { slots } = await schedule.read(customer, "schedule-slots", null, { ...choice, hostId: host.id });
  const { reservation } = await schedule.act(customer, "schedule-reserve", selectSlot(choice, slots[0]), "price");
  assert.equal(reservation.priceCents, 1000);
  time(reservation.startsAt);
  await act(host, "heartbeat", { available: true });
  priceCents = 1200;
  await assert.rejects(
    () => schedule.act(customer, "schedule-check-in", { reservationId: reservation.id }),
    { code: "SCHEDULE_PRICE_CHANGED" },
  );
  const empty = await db.prepare(
    "SELECT (SELECT COUNT(*) FROM mp_bookings) AS bookings,(SELECT COUNT(*) FROM mp_payments) AS payments",
  ).first();
  assert.equal(empty.bookings, 0);
  assert.equal(empty.payments, 0);
  priceCents = 1000;
  const { booking } = await schedule.act(customer, "schedule-check-in", { reservationId: reservation.id });
  priceCents = 1200;
  time(reservation.startsAt + 2000);
  await act(host, "accept", { bookingId: booking.id });
  const accepted = await service.read(customer, "booking", booking.id);
  assert.equal(accepted.amount_cents, reservation.priceCents);
  assert.equal(accepted.quote.id, booking.quote.id);
  assert.equal(accepted.quote.expiresAt, booking.quote.expiresAt + 2000);
});

test("reserving requires the displayed price and an acknowledged retry replays the same booking", async (t) => {
  let priceCents = 1000;
  const { schedule, db, customer, hosts: [host], choice } = await setup(t, {
    quoteFor: (input) => quoteFor(input, {
      ...BETA_PRICE_POLICY,
      prices: { 15: priceCents, 30: 1800 },
    }),
  });
  await schedule.act(host, "schedule-block-save", hostWindow, "block");
  const read = () => schedule.read(customer, "schedule-slots", null, { ...choice, hostId: host.id });
  const stale = (await read()).slots[0];
  assert.equal(stale.priceCents, 1000);
  priceCents = 1200;
  await assert.rejects(
    () => schedule.act(customer, "schedule-reserve", { ...choice, slotId: stale.id }, "missing-price"),
    { code: "VALIDATION" },
  );
  await assert.rejects(
    () => schedule.act(customer, "schedule-reserve", selectSlot(choice, stale), "stale-price"),
    { code: "SCHEDULE_PRICE_CHANGED" },
  );
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM mp_scheduled_reservations").first()).n, 0);
  const refreshed = (await read()).slots[0];
  assert.equal(refreshed.priceCents, 1200);
  const selected = selectSlot(choice, refreshed);
  const result = await schedule.act(customer, "schedule-reserve", selected, "confirmed-price");
  assert.equal(result.reservation.priceCents, 1200);
  priceCents = 1500;
  assert.deepEqual(await schedule.act(customer, "schedule-reserve", selected, "confirmed-price"), result);
  await assert.rejects(
    () => schedule.act(customer, "schedule-reserve", { ...selected, expectedPriceCents: 1500 }, "confirmed-price"),
    { code: "KEY_REUSED" },
  );
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM mp_payments").first()).n, 0);
});

test("deactivation, losing approval and blocking preserve expired no-show history", async (t) => {
  for (const cause of ["account", "approval", "block"]) {
    await t.test(cause, async (subtest) => {
      const now = Date.now();
      const startsAt = Math.floor(now / 3_600_000) * 3_600_000 - 3_600_000;
      const wall = (at) => new Date(at).toISOString().slice(0, 16);
      const fixture = await setup(subtest, { initialNow: startsAt - 60 * 60_000 });
      const { db, schedule, customer, hosts: [host], choice, time } = fixture;
      await schedule.act(host, "schedule-block-save", {
        timeZone: "UTC",
        startsLocal: wall(startsAt),
        endsLocal: wall(startsAt + 4 * 3_600_000),
      }, "block");
      const { slots } = await schedule.read(customer, "schedule-slots", null, { ...choice, hostId: host.id });
      const missed = (await schedule.act(customer, "schedule-reserve", selectSlot(choice, slots[0]), "missed")).reservation;
      const upcoming = (await schedule.act(customer, "schedule-reserve", selectSlot(choice, slots.at(-1)), "upcoming")).reservation;
      time(now);
      const readStates = async () => {
        const { reservations } = await schedule.read(customer, "scheduled-reservations");
        return [missed, upcoming].map((item) => reservations.find(({ id }) => id === item.id).status);
      };
      assert.deepEqual(await readStates(), ["EXPIRED", "SCHEDULED"]);
      if (cause === "account")
        await db.prepare("UPDATE mp_users SET status='SUSPENDED' WHERE id=?").bind(host.id).run();
      else if (cause === "approval")
        await db.prepare("UPDATE mp_host_profiles SET status='SUSPENDED',updated_at=? WHERE user_id=?").bind(now, host.id).run();
      else
        await db.prepare("INSERT INTO mp_blocks VALUES(?,?,?)").bind(customer.id, host.id, now).run();
      assert.deepEqual(await readStates(), ["EXPIRED", "CANCELLED"]);
    });
  }
});
