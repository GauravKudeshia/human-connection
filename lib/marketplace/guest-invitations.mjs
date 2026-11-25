import { createHmac } from "node:crypto";
import { fingerprint } from "../fingerprint.mjs";
import { requireCondition as need, text } from "./errors.mjs";

const pending = ["HOST_PENDING", "HOST_APPROVED", "ISSUED", "GUEST_WAITING"];
const active = [...pending, "GUEST_ADMITTED"];
const expiresWithInvitation = ["ISSUED", "GUEST_WAITING"];
const guestReportCategories = ["conduct", "privacy", "safety"];
const reportDispositions = ["reviewed", "follow-up-required"];
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

export function guestInvitationsEnabled(config) {
  return config?.HC_MARKETPLACE_ENABLED === "true" &&
    config.MARKETPLACE_MODE === "staging" &&
    config.MARKETPLACE_GUEST_INVITATIONS_ENABLED === "true";
}

export function requireGuestInvitations(config) {
  need(guestInvitationsEnabled(config),
    "GUEST_PREVIEW_DISABLED", "The staging guest preview is unavailable.", 503);
}

export function guestKey(secret, purpose) {
  const bytes = typeof secret === "string" ? Buffer.from(secret, "base64") : null;
  need(bytes?.length === 32,
    "GUEST_PREVIEW_UNCONFIGURED", "The staging guest preview is unavailable.", 503);
  return createHmac("sha256", bytes).update("human-connection/guest/v1/" + purpose).digest();
}
function liveRoomGuard(memberColumn) {
  return "EXISTS(SELECT 1 FROM mp_demo_guest_live_bookings live" +
    " WHERE live.id=mp_demo_guest_invitations.booking_id AND live.expires_at>?" +
    (memberColumn ? " AND live." + memberColumn + "=?" : "") + ")";
}
const liveGuard = liveRoomGuard();

function publicState(row, now) {
  let status = row?.status || "NOT_REQUESTED";
  if (active.includes(status) && !(row.live_until > now)) status = "SESSION_ENDED";
  else if (row?.live_until > now && row.invite_expires_at !== null &&
    (expiresWithInvitation.includes(status) || status === "SESSION_ENDED") &&
    row.invite_expires_at <= now) status = "EXPIRED";
  return { status, expiresAt: row?.invite_expires_at ?? null };
}

const unavailable = () =>
  need(false, "INVITATION_UNAVAILABLE", "This demo invitation is unavailable.", 404);

/** @param {any} db @param {{clock?:()=>number, signingSecret?:string}} [options] */
export function createGuestInvitations(db, { clock = Date.now, signingSecret } = {}) {
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

  async function issue(actor, bookingId, requestKey, now, actorGuard) {
    need(typeof requestKey === "string" && requestKey.length > 0 && requestKey.length <= 128,
      "IDEMPOTENCY_REQUIRED", "Provide an invitation request key.", 400);
    const requestDigest = digest("issue-request", requestKey);
    const invitationToken = createHmac("sha256", guestKey(signingSecret, "issue"))
      .update(JSON.stringify([actor.id, bookingId, requestKey])).digest("hex").slice(0, 48);
    const inviteDigest = digest("invite", invitationToken);
    await db.batch([
      statement(
        `UPDATE mp_demo_guest_invitations
         SET status='ISSUED',invite_digest=?,updated_at=?,
             invite_expires_at=COALESCE(invite_expires_at,
               MIN(?,(SELECT expires_at FROM mp_demo_guest_live_bookings WHERE id=?)))
         WHERE booking_id=? AND status IN ('HOST_APPROVED','ISSUED')
           AND (invite_expires_at IS NULL OR invite_expires_at>?) AND ${actorGuard}
           AND NOT EXISTS(SELECT 1 FROM mp_demo_guest_issue_requests
             WHERE booking_id=? AND request_digest=?)`,
        inviteDigest, now, now + 180_000, bookingId, bookingId, now, now, actor.id,
        bookingId, requestDigest,
      ),
      statement(
        `INSERT INTO mp_demo_guest_issue_requests(booking_id,request_digest)
         SELECT booking_id,? FROM mp_demo_guest_invitations
         WHERE booking_id=? AND status='ISSUED' AND invite_digest=?
         ON CONFLICT(booking_id,request_digest) DO NOTHING`,
        requestDigest, bookingId, inviteDigest,
      ),
    ]);
    const current = await first(
      `SELECT status,invite_expires_at FROM mp_demo_guest_invitations
       WHERE booking_id=? AND status='ISSUED' AND invite_digest=? AND invite_expires_at>? AND ${actorGuard}`,
      bookingId, inviteDigest, now, now, actor.id,
    );
    need(current, "INVITATION_TRANSITION", "The room or invitation changed. Refresh and check the current step.");
    return { status: current.status, expiresAt: current.invite_expires_at, invitationToken };
  }

  async function act(actor, action, bookingId, requestKey) {
    const row = await owned(actor, bookingId);
    const now = clock();
    const isRequest = action === "guest-invite-request";
    const isIssue = action === "guest-invite-issue";
    const role = isRequest || isIssue ? "customer" : transitions[action][0];
    const memberColumn = role === "customer" ? "customer_id" : "host_id";
    need(row[memberColumn] === actor.id, "FORBIDDEN", "This invitation action belongs to the " + role + ".", 403);
    const actorGuard = liveRoomGuard(memberColumn);
    if (isIssue) return issue(actor, bookingId, requestKey, now, actorGuard);
    let changed;
    if (isRequest) {
      changed = await first(
        `INSERT INTO mp_demo_guest_invitations(booking_id,status,created_at,updated_at)
         SELECT id,'HOST_PENDING',?,? FROM mp_demo_guest_live_bookings
         WHERE id=? AND customer_id=? AND expires_at>?
         ON CONFLICT(booking_id) DO NOTHING RETURNING status,invite_expires_at`,
        now, now, bookingId, actor.id, now,
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
    const created = await first(
      `UPDATE mp_demo_guest_invitations
       SET guest_report_category=?,guest_reported_at=?
       WHERE guest_scope=? AND guest_digest=? AND status='GUEST_ADMITTED' AND ${liveGuard}
         AND guest_reported_at IS NULL
       RETURNING guest_reported_at`,
      category, now, ...args, now,
    );
    if (created) return { submitted: true, replayed: false };
    const original = await first(
      `SELECT guest_report_category FROM mp_demo_guest_invitations
       WHERE guest_scope=? AND guest_digest=? AND status='GUEST_ADMITTED' AND ${liveGuard}
         AND guest_reported_at IS NOT NULL`,
      ...args, now,
    );
    if (!original) unavailable();
    need(original.guest_report_category === category,
      "GUEST_REPORT_EXISTS", "One test report can be saved per guest visit. Your earlier report remains on file.");
    return { submitted: true, replayed: true };
  }

  async function reports() {
    return (await statement(
      `SELECT i.booking_id,i.guest_report_category AS category,i.guest_reported_at AS createdAt,
       CASE WHEN t.resolved_at IS NOT NULL THEN 'RESOLVED' WHEN t.assigned_to IS NOT NULL THEN 'ASSIGNED' ELSE 'OPEN' END AS status,
       t.assigned_to AS assignedTo,t.assigned_at AS assignedAt,t.disposition,t.resolved_at AS resolvedAt
       FROM mp_demo_guest_invitations i LEFT JOIN mp_demo_guest_report_triage t ON t.booking_id=i.booking_id
       WHERE i.guest_reported_at IS NOT NULL ORDER BY t.resolved_at IS NOT NULL,i.guest_reported_at DESC LIMIT 100`,
    ).all()).results;
  }

  async function actReport(actor, action, payload) {
    const bookingId = text(payload.bookingId, 128);
    const now = clock();
    if (action === "demo-guest-report-assign") {
      await statement(
        `INSERT INTO mp_demo_guest_report_triage(booking_id,assigned_to,assigned_at)
         SELECT booking_id,?,? FROM mp_demo_guest_invitations
         WHERE booking_id=? AND guest_reported_at IS NOT NULL ON CONFLICT(booking_id) DO NOTHING`,
        actor.id, now, bookingId,
      ).run();
    } else {
      need(action === "demo-guest-report-resolve" && reportDispositions.includes(payload.disposition),
        "VALIDATION", "Choose a guest report outcome.", 400);
      await statement(
        `UPDATE mp_demo_guest_report_triage SET disposition=?,resolved_at=?
         WHERE booking_id=? AND assigned_to=? AND resolved_at IS NULL`,
        payload.disposition, now, bookingId, actor.id,
      ).run();
    }
    const current = await first(
      "SELECT assigned_to,disposition,resolved_at FROM mp_demo_guest_report_triage WHERE booking_id=?",
      bookingId,
    );
    need(current?.assigned_to === actor.id &&
      (action === "demo-guest-report-assign" || current.disposition === payload.disposition),
      "GUEST_REPORT_TRANSITION", "The guest report is unavailable or has changed. Refresh the queue.");
    return { status: current.resolved_at === null ? "ASSIGNED" : "RESOLVED", disposition: current.disposition };
  }

  return { read, act, claim, guestState, leave, report, reports, actReport };
}

/** @param {any} db @param {{clock?:()=>number, policy?:{approved:boolean, safetyRetentionMs?:number}|null}} [options] */
export async function sweepGuestInvitations(db, { clock = Date.now, policy } = {}) {
  const now = clock();
  const statements = [
    db.prepare(
      `UPDATE mp_demo_guest_invitations SET status='SESSION_ENDED',invite_digest=NULL,updated_at=?
       WHERE (status IN ('ISSUED','GUEST_WAITING') AND invite_expires_at<=?)
          OR (status IN ('HOST_PENDING','HOST_APPROVED','ISSUED','GUEST_WAITING','GUEST_ADMITTED') AND NOT ${liveGuard})`,
    ).bind(now, now, now),
    db.prepare("DELETE FROM mp_demo_guest_claim_quota WHERE window<?")
      .bind(Math.floor(now / 60_000) - 2),
  ];
  const retention = policy?.safetyRetentionMs;
  if (policy?.approved && typeof retention === "number" && Number.isSafeInteger(retention) && retention >= 0) {
    statements.push(db.prepare(
      `UPDATE mp_demo_guest_invitations SET guest_report_category=NULL,guest_reported_at=NULL
       WHERE guest_reported_at IS NOT NULL
         AND status NOT IN ('HOST_PENDING','HOST_APPROVED','ISSUED','GUEST_WAITING','GUEST_ADMITTED')
         AND EXISTS(SELECT 1 FROM mp_demo_guest_report_triage t
           WHERE t.booking_id=mp_demo_guest_invitations.booking_id AND t.resolved_at<=?)
         AND NOT EXISTS(SELECT 1 FROM mp_bookings b JOIN mp_privacy_holds h
           ON h.user_id IN (b.customer_id,b.host_id) AND h.status='ACTIVE' AND h.scope IN ('ALL','SAFETY')
           WHERE b.id=mp_demo_guest_invitations.booking_id)`,
    ).bind(now - retention));
  }
  await db.batch(statements);
}
