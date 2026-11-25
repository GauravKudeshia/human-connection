import { bookableExperiences, stylesFor } from "../catalog.mjs";
import { normalizeLanguageTag } from "../conversation-languages.mjs";
import { fingerprint } from "../fingerprint.mjs";
import { requireCondition as need, text } from "./errors.mjs";
import { quoteFor as defaultQuoteFor } from "./pricing.mjs";
import {
  approvedSupply,
  hostLanguageRows,
  hostSearch,
  normalizedLanguageSql,
  supplyJoins,
} from "./supply.mjs";

const minute = 60_000;
const day = 24 * 60 * minute;
const horizon = 30 * day;
const step = 15 * minute;
const checkInEarly = 5 * minute;
const checkInLate = 3 * minute;
const checkoutWindow = 3 * minute;
const joinWindow = 3 * minute;
const requestWindow = 30_000;
const maximumSetup = requestWindow + checkoutWindow + joinWindow;
const postStartBuffer = checkInLate + maximumSetup;
const minimumBookingNotice = 10 * minute;
export const scheduledKeyPrefix = "schedule-check-in:";
const valid = (value, message) => need(value, "VALIDATION", message, 400);
const asId = (value) => text(value, 128);

export function resolveLocalScheduleTime(local, zone, occurrence) {
  valid(
    typeof local === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local),
    "Enter a valid local date and time.",
  );
  valid(typeof zone === "string" && zone.length <= 100 && !/^[+-]/.test(zone),
    "Enter a valid IANA time zone, such as America/New_York.");
  const naive = Date.parse(local + ":00Z");
  valid(
    Number.isFinite(naive) && new Date(naive).toISOString().slice(0, 16) === local,
    "Enter a valid local date and time.",
  );
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      calendar: "iso8601",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    valid(false, "Enter a valid IANA time zone, such as America/New_York.");
  }
  const wall = (ms) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(ms).map(({ type, value }) => [type, value]),
    );
    return parts.year + "-" + parts.month + "-" + parts.day + "T" + parts.hour + ":" + parts.minute;
  };
  const matches = new Set();
  for (const offset of [-day, -12 * 60 * minute, 0, 12 * 60 * minute, day]) {
    const sample = naive + offset;
    const utcOffset = Date.parse(wall(sample) + ":00Z") - sample;
    const candidate = naive - utcOffset;
    if (wall(candidate) === local) matches.add(candidate);
  }
  const ordered = Array.from(matches).sort((a, b) => a - b);
  valid(ordered.length, "That local time does not exist because clocks move forward. Choose another time.");
  valid(
    ordered.length === 1 || ["earlier", "later"].includes(occurrence),
    "That local time occurs twice when clocks move back. Select its first or second occurrence.",
  );
  return {
    at: occurrence === "later" ? ordered.at(-1) : ordered[0],
    timeZone: formatter.resolvedOptions().timeZone,
  };
}

// Existing immediate intervals have a short request phase, then checkout and joining.
const activeEnd = `booking.expires_at + CASE booking.status
 WHEN 'REQUESTED' THEN booking.duration*60000+${checkoutWindow + joinWindow}
 WHEN 'ACCEPTED' THEN booking.duration*60000+${joinWindow}
 WHEN 'READY' THEN booking.duration*60000 ELSE 0 END`;
const overlaps = (end, start) => `r.protected_from<${end} AND r.protected_until>${start}`;
const conflictsWithActive = `NOT EXISTS(
 SELECT 1 FROM mp_host_claims claim JOIN mp_bookings booking ON booking.id=claim.booking_id
 WHERE claim.expires_at>? AND booking.status IN ('REQUESTED','ACCEPTED','READY','LIVE')
 AND booking.created_at<? AND ${activeEnd}>?
 AND (claim.host_id IN (h.user_id,?) OR claim.customer_id IN (h.user_id,?)))`;
const conflictsWithScheduled = `NOT EXISTS(
 SELECT 1 FROM mp_scheduled_reservations r
 WHERE r.status='SCHEDULED' AND r.check_in_until>? AND ${overlaps("?", "?")}
 AND (r.host_id IN (h.user_id,?) OR r.customer_id IN (h.user_id,?)))`;

// Used in both the immediate preview and the transactional immediate reservation insert.
export const scheduledAvailability = `
 AND NOT EXISTS(
  SELECT 1 FROM mp_scheduled_reservations r
  WHERE (
    (r.status='SCHEDULED' AND r.check_in_until>? AND ${overlaps("?", "?")})
    OR (r.status='CHECKED_IN' AND EXISTS(
      SELECT 1 FROM mp_bookings linked WHERE linked.id=r.booking_id
      AND linked.status IN ('REQUESTED','ACCEPTED','READY','LIVE') AND linked.expires_at>?
    ))
  )
  AND (r.host_id IN (h.user_id,?) OR r.customer_id IN (h.user_id,?))
  AND (? IS NULL OR r.id<>?))`;
export function scheduledAvailabilityArgs(now, duration, actorId, scheduledId = null) {
  return [now, now + duration * minute + maximumSetup, now, now, actorId, actorId, scheduledId, scheduledId];
}

const scheduledSupply = supplyJoins + `
 JOIN mp_host_schedule_blocks block ON block.host_id=h.user_id
 WHERE ${approvedSupply} AND block.cancelled_at IS NULL
 AND h.user_id<>? AND c.experience=? AND c.expires_at>=?
 AND EXISTS(SELECT 1 FROM ${hostLanguageRows} WHERE ${normalizedLanguageSql}=?)
 AND EXISTS(SELECT 1 FROM json_each(h.formats) WHERE value=?)
 AND NOT EXISTS(
  SELECT 1 FROM mp_blocks WHERE (owner_id=? AND blocked_id=h.user_id)
  OR (owner_id=h.user_id AND blocked_id=?)
 )
 AND EXISTS(
  SELECT 1 FROM mp_users customer JOIN mp_user_roles role ON role.user_id=customer.id AND role.role='customer'
  JOIN mp_customer_eligibility e ON e.user_id=customer.id
  WHERE customer.id=? AND customer.status='ACTIVE' AND e.adult=1 AND e.us=1 AND e.policy_version='beta-2026-11'
 )`;
const supplyArgs = (customer, choice, through) => [
  customer, choice.experience, through, choice.language.toLowerCase(), choice.format,
  customer, customer, customer,
];
function choices(value) {
  const language = normalizeLanguageTag(value.language);
  const style = value.style || null;
  const { duration, format, experience } = value;
  valid(
    bookableExperiences.some(({ id }) => id === experience) &&
      [15, 30].includes(duration) && ["audio", "video"].includes(format) && language,
    "Choose an experience, duration, format and supported language.",
  );
  valid(!style || stylesFor(experience).some(({ id }) => id === style), "Choose a compatible style.");
  return { experience, style, duration, format, language };
}
function conflictArgs(now, from, until, customerId) {
  return [now, until, from, customerId, customerId, now, until, from, customerId, customerId];
}
const bookingInterval = (startsAt, duration) => ({
  startsAt,
  endsAt: startsAt + duration * minute,
  from: startsAt - checkInEarly,
  until: startsAt + duration * minute + postStartBuffer,
  checkInUntil: startsAt + checkInLate,
});
const showReservation = (value, now) => ({
  id: value.id,
  hostId: value.host_id,
  hostName: value.host_name,
  customerName: value.customer_name,
  startsAt: value.starts_at,
  endsAt: value.ends_at,
  checkInFrom: value.check_in_from,
  checkInUntil: value.check_in_until,
  mayCheckIn: value.status === "SCHEDULED" && value.check_in_from <= now && now < value.check_in_until,
  timeZone: value.time_zone,
  duration: value.duration,
  format: value.format,
  language: value.language,
  priceCents: value.price_cents,
  currency: value.currency,
  status: value.status === "SCHEDULED" && value.check_in_until <= now ? "EXPIRED" : value.status,
  bookingId: value.booking_id,
});

export function createScheduling(db, { clock = Date.now, authorize, service, quoteFor = defaultQuoteFor } = {}) {
  const sql = (query, ...args) => db.prepare(query).bind(...args);
  const first = (query, ...args) => sql(query, ...args).first();
  const all = async (query, ...args) => (await sql(query, ...args).all()).results;
  const reservationColumns = `SELECT r.*,b.time_zone,MAX(r.protected_from,b.starts_at) AS check_in_from,
   h.display_name AS host_name,c.display_name AS customer_name
   FROM mp_scheduled_reservations r JOIN mp_host_schedule_blocks b ON b.id=r.block_id
   JOIN mp_host_profiles h ON h.user_id=r.host_id JOIN mp_users c ON c.id=r.customer_id`;
  const scoped = (actor, reservationId) => first(
    reservationColumns + " WHERE r.id=? AND ? IN (r.customer_id,r.host_id)", reservationId, actor.id,
  );

  async function slots(actor, filter) {
    await authorize(actor, ["customer"]);
    const choice = choices(filter);
    const now = clock();
    const hostId = filter.hostId ? asId(filter.hostId) : null;
    const search = hostSearch(filter.query, choice.experience);
    const blocks = await all(
      `SELECT block.*, h.display_name AS host_name,h.biography,c.expires_at AS certification_until${scheduledSupply}
       AND block.ends_at>? AND block.starts_at<=? AND (? IS NULL OR h.user_id=?)${search.condition}
       ORDER BY block.starts_at, block.id LIMIT 200`,
      ...supplyArgs(actor.id, choice, now), now + minimumBookingNotice, now + horizon, hostId, hostId,
      ...search.parameters,
    );
    if (!blocks.length) return { slots: [] };
    const hostIds = JSON.stringify(Array.from(new Set(blocks.map(({ host_id }) => host_id))));
    const memberFilter = (column) => `${column}=? OR ${column} IN (SELECT value FROM json_each(?))`;
    const partyFilter = (alias) => `(${memberFilter(alias + ".host_id")} OR ${memberFilter(alias + ".customer_id")})`;
    const held = await all(
      `SELECT r.host_id,r.customer_id,r.protected_from AS starts_at,r.protected_until AS ends_at
       FROM mp_scheduled_reservations r
       WHERE r.status='SCHEDULED' AND r.check_in_until>? AND r.protected_from<? AND r.protected_until>?
       AND ${partyFilter("r")}
       UNION ALL
       SELECT claim.host_id,claim.customer_id,booking.created_at,${activeEnd}
       FROM mp_host_claims claim JOIN mp_bookings booking ON booking.id=claim.booking_id
       WHERE claim.expires_at>? AND booking.status IN ('REQUESTED','ACCEPTED','READY','LIVE')
       AND booking.created_at<? AND ${activeEnd}>? AND ${partyFilter("claim")}`,
      now, now + horizon, now, actor.id, hostIds, actor.id, hostIds,
      now, now + horizon, now, actor.id, hostIds, actor.id, hostIds,
    );
    const heldByMember = new Map();
    for (const interval of held) {
      for (const member of [interval.host_id, interval.customer_id]) {
        const entries = heldByMember.get(member) || [];
        entries.push(interval);
        heldByMember.set(member, entries);
      }
    }
    const available = [];
    const quote = quoteFor({ ...choice, now });
    for (const block of blocks) {
      const related = [...(heldByMember.get(actor.id) || []), ...(heldByMember.get(block.host_id) || [])];
      const elapsedSteps = Math.max(0, Math.ceil((now + minimumBookingNotice - block.starts_at) / step));
      for (let start = block.starts_at + elapsedSteps * step; start <= now + horizon; start += step) {
        const timing = bookingInterval(start, choice.duration);
        if (timing.until > Math.min(block.ends_at, block.certification_until, now + horizon)) break;
        if (related.some((r) => r.starts_at < timing.until && r.ends_at > timing.from)) continue;
        available.push({
          id: block.id + "." + timing.startsAt,
          hostId: block.host_id,
          hostName: block.host_name,
          biography: block.biography,
          startsAt: timing.startsAt,
          endsAt: timing.endsAt,
          timeZone: block.time_zone,
          priceCents: quote.totalCents,
          currency: quote.currency,
        });
      }
    }
    available.sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id));
    return { slots: available.slice(0, 30) };
  }

  async function saveBlock(actor, payload, key) {
    await authorize(actor, ["host"]);
    const start = resolveLocalScheduleTime(payload.startsLocal, payload.timeZone, payload.startOccurrence);
    const end = resolveLocalScheduleTime(payload.endsLocal, start.timeZone, payload.endOccurrence);
    const existing = async () => first(
      "SELECT * FROM mp_host_schedule_blocks WHERE host_id=? AND request_key=?", actor.id, key,
    );
    function verify(row) {
      need(
        row.starts_at === start.at && row.ends_at === end.at && row.time_zone === start.timeZone,
        "KEY_REUSED", "This request key belongs to different availability.",
      );
      return { blockId: row.id };
    }
    const replay = await existing();
    if (replay) return verify(replay);
    const now = clock();
    valid(
      start.at >= now + minimumBookingNotice && end.at <= now + horizon &&
        end.at - start.at >= 15 * minute + postStartBuffer && end.at - start.at <= 8 * 60 * minute,
      "Choose a future window of 25 minutes to eight hours within the next 30 days.",
    );
    await first(
      `INSERT INTO mp_host_schedule_blocks(id,host_id,starts_at,ends_at,time_zone,created_at,request_key)
       SELECT ?,?,?,?,?,?,? WHERE EXISTS(
        SELECT 1 FROM mp_users host JOIN mp_host_profiles h ON h.user_id=host.id
        JOIN mp_user_roles role ON role.user_id=host.id AND role.role='host'
        WHERE host.id=? AND host.status='ACTIVE' AND h.status='APPROVED'
       ) AND NOT EXISTS(
         SELECT 1 FROM mp_host_schedule_blocks WHERE host_id=? AND cancelled_at IS NULL AND starts_at<? AND ends_at>?
       ) ON CONFLICT(host_id,request_key) DO NOTHING RETURNING id`,
      crypto.randomUUID(), actor.id, start.at, end.at, start.timeZone, now, key,
      actor.id, actor.id, end.at, start.at,
    );
    const stored = await existing();
    need(stored, "SCHEDULE_UNAVAILABLE", "That window overlaps another window or your host approval has changed.");
    return verify(stored);
  }

  async function removeBlock(actor, payload) {
    await authorize(actor, ["host"]);
    const blockId = asId(payload.blockId);
    const owned = await first("SELECT cancelled_at FROM mp_host_schedule_blocks WHERE id=? AND host_id=?", blockId, actor.id);
    need(owned, "NOT_FOUND", "Availability window not found.", 404);
    if (owned.cancelled_at !== null) return { removed: true };
    const now = clock();
    const result = await first(
      `UPDATE mp_host_schedule_blocks SET cancelled_at=? WHERE id=? AND host_id=?
       AND cancelled_at IS NULL AND NOT EXISTS(SELECT 1 FROM mp_scheduled_reservations r
        WHERE r.block_id=mp_host_schedule_blocks.id AND (
         (r.status='SCHEDULED' AND r.check_in_until>?) OR
         (r.status='CHECKED_IN' AND EXISTS(SELECT 1 FROM mp_bookings b
          WHERE b.id=r.booking_id AND b.status IN ('REQUESTED','ACCEPTED','READY','LIVE') AND b.expires_at>?))
        ))
       RETURNING id`,
      now, blockId, actor.id, now, now,
    );
    const removed = result || (await first(
      "SELECT 1 FROM mp_host_schedule_blocks WHERE id=? AND host_id=? AND cancelled_at IS NOT NULL", blockId, actor.id,
    ));
    need(removed, "SCHEDULE_RESERVED", "Cancel the scheduled booking before removing this window.");
    return { removed: true };
  }

  async function reserve(actor, payload, key) {
    await authorize(actor, ["customer"]);
    const choice = choices(payload);
    const match = /^([0-9a-f-]{36})\.(\d{13})$/.exec(asId(payload.slotId));
    valid(match, "Choose an available time.");
    const [, blockId, start] = match;
    const timing = bookingInterval(Number(start), choice.duration);
    const { expectedPriceCents, expectedCurrency } = payload;
    valid(
      Number.isSafeInteger(expectedPriceCents) && expectedPriceCents > 0 && expectedCurrency === "USD",
      "Choose an available time with its displayed test price.",
    );
    const digest = fingerprint(JSON.stringify({
      slotId: payload.slotId, ...choice, expectedPriceCents, expectedCurrency,
    }));
    const existing = () => first(
      reservationColumns + " WHERE r.customer_id=? AND r.request_key=?", actor.id, key,
    );
    const now = clock();
    function verify(row) {
      need(row.fingerprint === digest, "KEY_REUSED", "This request key belongs to a different scheduled booking.");
      return { reservation: showReservation(row, now) };
    }
    const replay = await existing();
    if (replay) return verify(replay);
    valid(
      timing.startsAt >= now + minimumBookingNotice && timing.until <= now + horizon,
      "That time is no longer open for scheduling. Choose another time.",
    );
    const quote = quoteFor({ ...choice, now });
    need(
      quote.totalCents === expectedPriceCents && quote.currency === expectedCurrency,
      "SCHEDULE_PRICE_CHANGED",
      "The test price changed. No time was reserved and no charge was made. Choose a time at the updated price.",
    );
    await first(
      `INSERT INTO mp_scheduled_reservations(id,block_id,customer_id,host_id,starts_at,ends_at,
       protected_from,protected_until,check_in_until,experience,style,duration,format,language,price_cents,
       currency,request_key,fingerprint,created_at,updated_at)
       SELECT ?,block.id,?,h.user_id,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?${scheduledSupply}
       AND block.id=? AND block.starts_at<=? AND block.ends_at>=? AND ((?-block.starts_at) % ${step})=0
       AND ${conflictsWithActive} AND ${conflictsWithScheduled}
       ON CONFLICT(customer_id,request_key) DO NOTHING RETURNING id`,
      crypto.randomUUID(), actor.id, timing.startsAt, timing.endsAt, timing.from, timing.until, timing.checkInUntil,
      choice.experience, choice.style, choice.duration, choice.format, choice.language, quote.totalCents,
      quote.currency, key, digest, now, now, ...supplyArgs(actor.id, choice, timing.until),
      blockId, timing.startsAt, timing.until, timing.startsAt, ...conflictArgs(now, timing.from, timing.until, actor.id),
    );
    const stored = await existing();
    need(stored, "SCHEDULE_UNAVAILABLE", "That scheduled time is no longer available.");
    return verify(stored);
  }

  async function cancel(actor, payload) {
    await authorize(actor, ["host", "customer"]);
    const reservationId = asId(payload.reservationId);
    const now = clock();
    const row = await scoped(actor, reservationId);
    need(row, "NOT_FOUND", "Scheduled booking not found.", 404);
    if (row.status !== "CANCELLED")
      await first(
        `UPDATE mp_scheduled_reservations SET status='CANCELLED',updated_at=?
         WHERE id=? AND ? IN (customer_id,host_id) AND status='SCHEDULED' AND check_in_until>? RETURNING id`,
        now, reservationId, actor.id, now,
      );
    const current = await scoped(actor, reservationId);
    need(current?.status === "CANCELLED", "INVALID_STATE", "This scheduled booking can no longer be cancelled here.");
    return { reservation: showReservation(current, now) };
  }

  async function checkIn(actor, payload) {
    await authorize(actor, ["customer"]);
    const reservationId = asId(payload.reservationId);
    const row = await scoped(actor, reservationId);
    need(row?.customer_id === actor.id, "NOT_FOUND", "Scheduled booking not found.", 404);
    if (row.status === "CHECKED_IN")
      return { booking: await service.read(actor, "booking", row.booking_id) };
    const now = clock();
    need(
      row.status === "SCHEDULED" && row.check_in_from <= now && now < row.check_in_until,
      "SCHEDULE_CHECK_IN_CLOSED", "Check in during the window shown on your scheduled booking.",
    );
    try {
      return await service.reserveScheduled(actor, row);
    } catch (error) {
      if (["NO_MATCH", "HOST_RESERVED"].includes(error.code)) {
        const current = await scoped(actor, reservationId);
        need(
          current?.status === "SCHEDULED" && current.check_in_until > clock(),
          "SCHEDULE_CHECK_IN_CLOSED", "This scheduled booking is no longer open for check-in.",
        );
        need(false, "SCHEDULE_HOST_NOT_READY", "Your scheduled host isn’t ready yet. Try again during your check-in window.");
      }
      throw error;
    }
  }

  async function read(actor, resource, id, filter) {
    if (resource === "schedule-slots") return slots(actor, filter);
    if (resource === "host-schedule") {
      await authorize(actor, ["host"]);
      const blocks = await all(
        `SELECT id, starts_at AS startsAt, ends_at AS endsAt, time_zone AS timeZone
         FROM mp_host_schedule_blocks WHERE host_id=? AND cancelled_at IS NULL AND ends_at>?
         ORDER BY starts_at LIMIT 50`,
        actor.id, clock(),
      );
      return { blocks };
    }
    const hostView = id === "host";
    await authorize(actor, [hostView ? "host" : "customer"]);
    const now = clock();
    const rows = await all(
      reservationColumns + ` WHERE r.${hostView ? "host" : "customer"}_id=?
       ORDER BY CASE WHEN r.status='SCHEDULED' AND r.check_in_until>? THEN 0 ELSE 1 END,
       CASE WHEN r.check_in_until>? THEN r.starts_at ELSE -r.starts_at END LIMIT 50`,
      actor.id, now, now,
    );
    return { reservations: rows.map((row) => showReservation(row, now)) };
  }

  function act(actor, action, payload, key) {
    if (action === "schedule-block-save") return saveBlock(actor, payload, key);
    if (action === "schedule-block-remove") return removeBlock(actor, payload);
    if (action === "schedule-reserve") return reserve(actor, payload, key);
    if (action === "schedule-cancel") return cancel(actor, payload);
    return checkIn(actor, payload);
  }
  return { read, act };
}

export const schedulingReads = new Set(["schedule-slots", "host-schedule", "scheduled-reservations"]);
export const schedulingActions = new Set([
  "schedule-block-save", "schedule-block-remove", "schedule-reserve", "schedule-cancel", "schedule-check-in",
]);
