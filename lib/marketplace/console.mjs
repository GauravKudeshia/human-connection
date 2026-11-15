import { requireCondition as need, text } from "./errors.mjs";
export function createOperationsConsole(
  db,
  { authorize, clock = Date.now } = {},
) {
  const sql = (q, ...v) => db.prepare(q).bind(...v),
    rows = async (q, ...v) => (await sql(q, ...v).all()).results;
  async function read(actor, resource) {
    const roles = await authorize(actor, ["admin", "safety"], true);
    if (resource === "accounts")
      return rows(
        "SELECT u.id,u.display_name,u.status,u.created_at FROM mp_users u WHERE ?=1 OR EXISTS(SELECT 1 FROM mp_safety_reports r WHERE r.reported_id=u.id OR r.reporter_id=u.id) ORDER BY u.created_at DESC LIMIT 100",
        Number(roles.includes("admin")),
      );
    await authorize(actor, ["admin"], true);
    if (resource === "booking-oversight")
      return rows(
        "SELECT id,customer_id,host_id,status,experience,duration,format,amount_cents,currency,expires_at,created_at FROM mp_bookings ORDER BY created_at DESC LIMIT 100",
      );
    if (resource === "availability")
      return rows(
        "SELECT h.user_id id,h.display_name,h.status,p.available,p.last_seen_at FROM mp_host_profiles h LEFT JOIN mp_host_presence p ON p.host_id=h.user_id ORDER BY h.updated_at DESC LIMIT 100",
      );
    need(false, "NOT_FOUND", "Operations resource not found.", 404);
  }
  async function accountStatus(actor, payload) {
    const roles = await authorize(actor, ["admin", "safety"], true),
      targetId = text(payload.userId, 128),
      reason = text(payload.reason),
      status = payload.status;
    need(
      ["ACTIVE", "SUSPENDED"].includes(status) && targetId !== actor.id,
      "VALIDATION",
      "Choose another account and an available status.",
      400,
    );
    need(
      status !== "ACTIVE" || roles.includes("admin"),
      "FORBIDDEN",
      "Only an administrator may reinstate an account.",
      403,
    );
    const target = await sql(
      "SELECT status FROM mp_users WHERE id=?",
      targetId,
    ).first();
    need(
      target && target.status !== "CLOSED",
      "NOT_FOUND",
      "An open account is required.",
      404,
    );
    if (target.status === status) return { status, replayed: true };
    const eventId = crypto.randomUUID(),
      now = clock(),
      guard = "EXISTS(SELECT 1 FROM mp_audit_events WHERE id=?)";
    const result = await db.batch([
      sql(
        "INSERT INTO mp_audit_events SELECT ?,?,?,'account-status',?,? FROM mp_users target WHERE target.id=? AND target.status=? AND EXISTS(SELECT 1 FROM mp_users staff JOIN mp_user_roles role ON role.user_id=staff.id WHERE staff.id=? AND staff.status='ACTIVE' AND (role.role='admin' OR (role.role='safety' AND ?='SUSPENDED' AND EXISTS(SELECT 1 FROM mp_safety_reports c WHERE c.reported_id=target.id AND c.status<>'CLOSED' AND c.assigned_to=staff.id))))",
        eventId,
        actor.id,
        targetId,
        JSON.stringify({ status, reason }),
        now,
        targetId,
        target.status,
        actor.id,
        status,
      ),
      sql(
        "UPDATE mp_users SET status=? WHERE id=? AND " + guard,
        status,
        targetId,
        eventId,
      ),
      ...(status === "SUSPENDED"
        ? [
            sql(
              "UPDATE mp_auth_sessions SET revoked_at=? WHERE subject=(SELECT provider_subject FROM mp_users WHERE id=?) AND revoked_at IS NULL AND " +
                guard,
              now,
              targetId,
              eventId,
            ),
            sql(
              "UPDATE mp_host_presence SET available=0,last_seen_at=? WHERE host_id=? AND " +
                guard,
              now,
              targetId,
              eventId,
            ),
            sql(
              "UPDATE mp_host_profiles SET status='SUSPENDED',updated_at=? WHERE user_id=? AND " +
                guard,
              now,
              targetId,
              eventId,
            ),
            sql(
              "INSERT INTO mp_booking_events SELECT lower(hex(randomblob(16))),id,?,'account-suspended',CASE WHEN status IN ('READY','LIVE') THEN 'SAFETY_ENDED' ELSE 'CANCELLED' END,? FROM mp_bookings WHERE (customer_id=? OR host_id=?) AND status IN ('REQUESTED','ACCEPTED','READY','LIVE') AND " +
                guard,
              actor.id,
              now,
              targetId,
              targetId,
              eventId,
            ),
            sql(
              "INSERT OR IGNORE INTO mp_refunds(id,booking_id,payment_id,reason,status,created_at,updated_at) SELECT lower(hex(randomblob(16))),p.booking_id,p.id,'Account suspended. Delivery and refund review required.','OPEN',?,? FROM mp_payments p JOIN mp_bookings b ON b.id=p.booking_id WHERE (b.customer_id=? OR b.host_id=?) AND b.status IN ('REQUESTED','ACCEPTED','READY','LIVE') AND p.status='CAPTURED' AND " +
                guard,
              now,
              now,
              targetId,
              targetId,
              eventId,
            ),
            sql(
              "UPDATE mp_bookings SET status=CASE WHEN status IN ('READY','LIVE') THEN 'SAFETY_ENDED' ELSE 'CANCELLED' END,updated_at=? WHERE (customer_id=? OR host_id=?) AND status IN ('REQUESTED','ACCEPTED','READY','LIVE') AND " +
                guard,
              now,
              targetId,
              targetId,
              eventId,
            ),
            sql(
              "DELETE FROM mp_host_claims WHERE (customer_id=? OR host_id=?) AND " +
                guard,
              targetId,
              targetId,
              eventId,
            ),
            sql(
              "UPDATE mp_video_rooms SET status='CLOSING' WHERE booking_id IN (SELECT id FROM mp_bookings WHERE customer_id=? OR host_id=?) AND status IN ('PROVISIONING','READY') AND " +
                guard,
              targetId,
              targetId,
              eventId,
            ),
          ]
        : []),
    ]);
    need(
      result[0].meta.changes === 1,
      "CONCURRENT_UPDATE",
      "The account or case permissions changed. Refresh and retry.",
    );
    return { status, mediaCleanupPending: status === "SUSPENDED" };
  }
  return { read, accountStatus };
}
