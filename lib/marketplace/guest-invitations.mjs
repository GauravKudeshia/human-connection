import { fingerprint } from "../fingerprint.mjs";
import { requireCondition as need, text } from "./errors.mjs";

const pending = ["HOST_PENDING", "HOST_APPROVED", "ISSUED", "GUEST_WAITING"];
const active = [...pending, "GUEST_ADMITTED"];
const expiresWithInvitation = ["ISSUED", "GUEST_WAITING"];
const guestReportCategories = ["conduct", "privacy", "safety"];
const transitions = {
  "guest-invite-host-approve": ["host", ["HOST_PENDING"], "HOST_APPROVED"],
  "guest-invite-host-decline": ["host", ["HOST_PENDING"], "HOST_DECLINED"],
  "guest-invite-admit": ["customer", ["GUEST_WAITING"], "GUEST_ADMITTED"],
  "guest-invite-decline": ["customer", ["GUEST_WAITING"], "CUSTOMER_DECLINED"],
  "guest-invite-cancel": ["customer", pending, "REVOKED"],
  "guest-invite-withdraw": ["host", active, "REVOKED"],
  "guest-invite-remove": ["customer", ["GUEST_ADMITTED"], "GUEST_REMOVED"],
};
export const guestInvitationActions = new Set([
  "guest-invite-request",
  "guest-invite-issue",
  ...Object.keys(transitions),
]);
const isToken = (value) => typeof value === "string" && /^[0-9a-f]{48}$/.test(value);
const newToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const digest = (type, value) => fingerprint(type + ":" + value);
function liveRoomGuard(memberColumn) {
  return "EXISTS(SELECT 1 FROM mp_demo_guest_live_bookings live" +
    " WHERE live.id=mp_demo_guest_invitations.booking_id AND live.expires_at>?" +
    (memberColumn ? " AND live." + memberColumn + "=?" : "") + ")";
}
const liveGuard = liveRoomGuard();

function publicState(row, now) {
  let status = row?.status || "NOT_REQUESTED";
  if (active.includes(status) && !(row.live_until > now)) status = "SESSION_ENDED";
  else if (expiresWithInvitation.includes(status) && row.invite_expires_at <= now) status = "EXPIRED";
  return { status, expiresAt: row?.invite_expires_at ?? null };
}

const unavailable = () =>
  need(false, "INVITATION_UNAVAILABLE", "This demo invitation is unavailable.", 404);

export function createGuestInvitations(db, { clock = Date.now } = {}) {
  const statement = (sql, ...args) => db.prepare(sql).bind(...args);
  const first = (sql, ...args) => statement(sql, ...args).first();

  async function owned(actor, bookingId) {
    const id = text(bookingId, 128);
    const row = await first(
      `SELECT b.customer_id,b.host_id,i.status,i.invite_expires_at,live.expires_at AS live_until
       FROM mp_bookings b
       JOIN mp_users member ON member.id=? AND member.status='ACTIVE'
       LEFT JOIN mp_demo_guest_invitations i ON i.booking_id=b.id
       LEFT JOIN mp_demo_guest_live_bookings live ON live.id=b.id
       WHERE b.id=? AND (member.id=b.customer_id OR member.id=b.host_id)`,
      actor.id, id,
    );
    if (!row) unavailable();
    return row;
  }

  async function read(actor, bookingId) {
    return publicState(await owned(actor, bookingId), clock());
  }

  async function act(actor, action, bookingId) {
    const row = await owned(actor, bookingId);
    const now = clock();
    const isRequest = action === "guest-invite-request";
    const isIssue = action === "guest-invite-issue";
    const role = isRequest || isIssue ? "customer" : transitions[action][0];
    const memberColumn = role === "customer" ? "customer_id" : "host_id";
    need(row[memberColumn] === actor.id, "FORBIDDEN", "This invitation action belongs to the " + role + ".", 403);
    const actorGuard = liveRoomGuard(memberColumn);
    let changed;
    let invitationToken;
    if (isRequest) {
      changed = await first(
        `INSERT INTO mp_demo_guest_invitations(booking_id,status,created_at,updated_at)
         SELECT id,'HOST_PENDING',?,? FROM mp_demo_guest_live_bookings
         WHERE id=? AND customer_id=? AND expires_at>?
         ON CONFLICT(booking_id) DO NOTHING RETURNING status,invite_expires_at`,
        now, now, bookingId, actor.id, now,
      );
    } else if (isIssue) {
      invitationToken = newToken();
      changed = await first(
        `UPDATE mp_demo_guest_invitations
         SET status='ISSUED',invite_digest=?,updated_at=?,
             invite_expires_at=COALESCE(invite_expires_at,
               MIN(?,(SELECT expires_at FROM mp_demo_guest_live_bookings WHERE id=?)))
         WHERE booking_id=? AND status IN ('HOST_APPROVED','ISSUED')
           AND (invite_expires_at IS NULL OR invite_expires_at>?) AND ${actorGuard}
         RETURNING status,invite_expires_at`,
        digest("invite", invitationToken), now, now + 180_000, bookingId, bookingId, now, now, actor.id,
      );
    } else {
      const [, from, to] = transitions[action];
      changed = await first(
        `UPDATE mp_demo_guest_invitations SET status=?,invite_digest=NULL,updated_at=?
         WHERE booking_id=? AND status IN (${from.map(() => "?").join(",")})
           AND (status NOT IN ('ISSUED','GUEST_WAITING') OR invite_expires_at>?) AND ${actorGuard}
         RETURNING status,invite_expires_at`,
        to, now, bookingId, ...from, now, now, actor.id,
      );
    }
    need(changed, "INVITATION_TRANSITION", "The room or invitation changed. Refresh and check the current step.");
    return {
      status: changed.status,
      expiresAt: changed.invite_expires_at,
      ...(invitationToken ? { invitationToken } : {}),
    };
  }

  async function claim(token, terms) {
    if (!isToken(token)) unavailable();
    need(
      terms?.adult === true && terms?.us === true && terms?.accepted === true,
      "GUEST_CONSENT_REQUIRED", "Confirm the demo age, location and participation terms.", 400,
    );
    const now = clock();
    const binding = newToken();
    const scope = newToken();
    const row = await first(
      `UPDATE mp_demo_guest_invitations
       SET status='GUEST_WAITING',invite_digest=NULL,guest_scope=?,guest_digest=?,
           guest_terms_version='demo-2026-11',updated_at=?
       WHERE invite_digest=? AND status='ISSUED' AND invite_expires_at>? AND ${liveGuard}
       RETURNING invite_expires_at,(SELECT expires_at FROM mp_demo_guest_live_bookings
         WHERE id=mp_demo_guest_invitations.booking_id) AS live_until`,
      scope, digest("binding", binding), now, digest("invite", token), now, now,
    );
    if (!row) unavailable();
    return {
      data: { status: "GUEST_WAITING", expiresAt: row.invite_expires_at, scope },
      binding,
      maxAge: Math.ceil((row.live_until - now) / 1000),
    };
  }

  function verifyGuest(scope, binding) {
    if (!isToken(scope) || !isToken(binding)) unavailable();
    return [scope, digest("binding", binding)];
  }

  async function guestState(scope, binding) {
    const args = verifyGuest(scope, binding);
    const row = await first(
      `SELECT i.status,i.invite_expires_at,live.expires_at AS live_until
       FROM mp_demo_guest_invitations i LEFT JOIN mp_demo_guest_live_bookings live ON live.id=i.booking_id
       WHERE guest_scope=? AND guest_digest=?`,
      ...args,
    );
    if (!row) unavailable();
    return publicState(row, clock());
  }

  async function leave(scope, binding) {
    const args = verifyGuest(scope, binding);
    const now = clock();
    const row = await first(
      `UPDATE mp_demo_guest_invitations
       SET status='GUEST_LEFT',updated_at=?,guest_scope=NULL,guest_digest=NULL
       WHERE guest_scope=? AND guest_digest=? AND status IN ('GUEST_WAITING','GUEST_ADMITTED')
         AND (status='GUEST_ADMITTED' OR invite_expires_at>?) AND ${liveGuard}
       RETURNING status`,
      now, ...args, now, now,
    );
    if (!row) unavailable();
    return { status: row.status };
  }

  async function report(scope, binding, category) {
    const args = verifyGuest(scope, binding);
    need(guestReportCategories.includes(category), "VALIDATION", "Choose a report category.", 400);
    const now = clock();
    const row = await first(
      `UPDATE mp_demo_guest_invitations
       SET guest_report_category=COALESCE(guest_report_category,?),
           guest_reported_at=COALESCE(guest_reported_at,?)
       WHERE guest_scope=? AND guest_digest=? AND status='GUEST_ADMITTED' AND ${liveGuard}
       RETURNING guest_reported_at`,
      category, now, ...args, now,
    );
    if (!row) unavailable();
    return { submitted: true };
  }

  async function reports() {
    return (await statement(
      `SELECT booking_id,guest_report_category AS category,guest_reported_at AS createdAt
       FROM mp_demo_guest_invitations WHERE guest_reported_at IS NOT NULL
       ORDER BY guest_reported_at DESC LIMIT 100`,
    ).all()).results;
  }

  return { read, act, claim, guestState, leave, report, reports };
}
