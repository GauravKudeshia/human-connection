import { requireCondition as need } from "./errors.mjs";
import { allocationFor } from "./pricing.mjs";

const active = ["READY", "LIVE"];
function union(intervals) {
  const result = [];
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    const previous = result.at(-1);
    if (previous && start <= previous[1])
      previous[1] = Math.max(previous[1], end);
    else result.push([start, end]);
  }
  return result;
}
export function overlapIntervals(
  rows,
  customerId,
  hostId,
  end = Infinity,
  closedOnly = true,
) {
  const intervals = (user) =>
    union(
      rows
        .filter(
          (row) =>
            row.user_id === user && (!closedOnly || row.left_at !== null),
        )
        .map((row) => [row.joined_at, Math.min(row.left_at ?? Infinity, end)])
        .filter(([start, finish]) => finish > start),
    );
  const customer = intervals(customerId),
    host = intervals(hostId);
  let milliseconds = 0,
    first = null;
  for (const a of customer)
    for (const b of host) {
      const start = Math.max(a[0], b[0]),
        finish = Math.min(a[1], b[1]);
      if (finish > start) {
        first = first === null ? start : Math.min(first, start);
        milliseconds += finish - start;
      }
    }
  return { milliseconds, first };
}
/**
 * @param {any} db
 * @param {{videoProvider?: ReturnType<typeof import("./providers.mjs").createDailyTestProvider>, clock?: () => number}} [options]
 */
export function createSessionService(
  db,
  { videoProvider, clock = Date.now } = {},
) {
  const statement = (sql, ...args) => db.prepare(sql).bind(...args);
  const first = (sql, ...args) => statement(sql, ...args).first();
  async function owned(actor, bookingId) {
    const user = await first(
      "SELECT status FROM mp_users WHERE id=?",
      actor?.id || "",
    );
    need(
      user?.status === "ACTIVE",
      "FORBIDDEN",
      "An active participant account is required.",
      403,
    );
    const b = await first(
      "SELECT * FROM mp_bookings WHERE id=? AND (customer_id=? OR host_id=?)",
      bookingId,
      actor.id,
      actor.id,
    );
    need(b, "NOT_FOUND", "Session not found.", 404);
    return b;
  }
  async function timing(bookingId) {
    await statement(
      "INSERT OR IGNORE INTO mp_session_timing(booking_id) VALUES(?)",
      bookingId,
    ).run();
    return first(
      "SELECT * FROM mp_session_timing WHERE booking_id=?",
      bookingId,
    );
  }
  async function assertHostEligible(b, now) {
    const host = await first(
      "SELECT h.status,u.status account_status,v.status verification_status,v.adult_verified,v.jurisdiction,v.payout_status,c.status certification_status,c.expires_at certification_expires FROM mp_host_profiles h JOIN mp_users u ON u.id=h.user_id JOIN mp_host_verifications v ON v.user_id=h.user_id JOIN mp_certifications c ON c.host_id=h.user_id AND c.experience=? WHERE h.user_id=?",
      b.experience,
      b.host_id,
    );
    need(
      host?.status === "APPROVED" &&
        host.account_status === "ACTIVE" &&
        host.verification_status === "VERIFIED" &&
        host.adult_verified === 1 &&
        host.jurisdiction === "US" &&
        host.payout_status === "ELIGIBLE" &&
        host.certification_status === "APPROVED" &&
        host.certification_expires > now,
      "HOST_UNAVAILABLE",
      "The host is unavailable.",
      409,
    );
  }
  async function roomToken(actor, bookingId) {
    const b = await owned(actor, bookingId),
      now = clock();
    const payment = await first(
      "SELECT status FROM mp_payments WHERE booking_id=?",
      b.id,
    );
    need(
      active.includes(b.status) &&
        b.expires_at > now &&
        payment?.status === "CAPTURED",
      "SESSION_UNAVAILABLE",
      "A paid active reservation is required.",
      409,
    );
    await assertHostEligible(b, now);
    need(
      videoProvider,
      "VIDEO_NOT_CONFIGURED",
      "Private video is not configured.",
      503,
    );
    const roomName = "hc-test-" + b.id;
    const maximumExpiry = now + b.duration * 60000 + 180000;
    await statement(
      "INSERT OR IGNORE INTO mp_video_rooms(booking_id,room_name,status,created_at,expires_at) VALUES(?,?,'PROVISIONING',?,?)",
      b.id,
      roomName,
      now,
      maximumExpiry,
    ).run();
    await timing(b.id);
    let room = await first(
      "SELECT * FROM mp_video_rooms WHERE booking_id=?",
      b.id,
    );
    need(
      ["PROVISIONING", "READY"].includes(room.status),
      "SESSION_UNAVAILABLE",
      "This room is closing.",
      409,
    );
    if (room.status === "PROVISIONING") {
      const created = await videoProvider.createRoom(
        { bookingId: b.id, expiresAt: room.expires_at, format: b.format },
        now,
      );
      const parsed = new URL(created.url);
      need(
        parsed.protocol === "https:" &&
          parsed.hostname.endsWith(".daily.co") &&
          created.name === roomName &&
          parsed.pathname === "/" + roomName &&
          created.privacy === "private",
        "PROVIDER_MISMATCH",
        "The provider returned a different room.",
        502,
      );
      await statement(
        "UPDATE mp_video_rooms SET status='READY',room_url=? WHERE booking_id=? AND status='PROVISIONING'",
        created.url,
        b.id,
      ).run();
      room = await first(
        "SELECT * FROM mp_video_rooms WHERE booking_id=?",
        b.id,
      );
    }
    const current = await owned(actor, b.id);
    const currentPayment = await first(
      "SELECT status FROM mp_payments WHERE booking_id=?",
      b.id,
    );
    need(
      active.includes(current.status) &&
        current.expires_at > clock() &&
        currentPayment?.status === "CAPTURED" &&
        room.status === "READY",
      "SESSION_UNAVAILABLE",
      "The reservation changed before entry.",
      409,
    );
    const expiresAt = Math.min(
      room.expires_at,
      current.status === "LIVE" ? current.expires_at : room.expires_at,
    );
    const grant = await videoProvider.participantToken(
      { roomName, actorId: actor.id, expiresAt },
      clock(),
    );
    const recheck = await owned(actor, b.id);
    const finalPayment = await first(
      "SELECT status FROM mp_payments WHERE booking_id=?",
      b.id,
    );
    const finalClaim = await first(
      "SELECT booking_id FROM mp_host_claims WHERE booking_id=? AND expires_at>?",
      b.id,
      clock(),
    );
    await assertHostEligible(b, clock());
    need(
      active.includes(recheck.status) && recheck.expires_at > clock(),
      "SESSION_UNAVAILABLE",
      "The session ended while entry was being authorized.",
      409,
    );
    need(
      finalPayment?.status === "CAPTURED" && finalClaim,
      "SESSION_UNAVAILABLE",
      "The paid reservation changed before entry.",
      409,
    );
    need(
      typeof grant.token === "string" && grant.token.length > 0,
      "PROVIDER_MISMATCH",
      "The provider could not grant entry.",
      502,
    );
    return {
      bookingId: b.id,
      roomName,
      roomUrl: room.room_url,
      token: grant.token,
      expiresAt,
      format: b.format,
    };
  }
  async function reconcile(bookingId) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const b = await first("SELECT * FROM mp_bookings WHERE id=?", bookingId);
      const t = await timing(bookingId);
      const room = await first(
        "SELECT * FROM mp_video_rooms WHERE booking_id=?",
        bookingId,
      );
      if (!room) return;
      const rows = (
        await statement(
          "SELECT * FROM mp_session_presence WHERE booking_id=?",
          bookingId,
        ).all()
      ).results;
      const proof = overlapIntervals(
        rows,
        b.customer_id,
        b.host_id,
        Infinity,
        false,
      );
      const timelyFirst =
        proof.first !== null && proof.first <= b.expires_at
          ? proof.first
          : null;
      const started = t.started_at ?? timelyFirst;
      const deadline =
        started === null ? b.expires_at : started + b.duration * 60000;
      const upper = Math.min(t.ended_at ?? Infinity, deadline);
      const overlap =
        started === null
          ? 0
          : Math.min(
              b.duration * 60000,
              overlapIntervals(rows, b.customer_id, b.host_id, upper, true)
                .milliseconds,
            );
      const payment = await first(
        "SELECT * FROM mp_payments WHERE booking_id=?",
        bookingId,
      );
      const complete =
        overlap >= b.duration * 60000 &&
        t.reason !== "SAFETY" &&
        payment?.status === "CAPTURED";
      const canStart =
        b.status === "READY" &&
        started !== null &&
        started <= b.expires_at &&
        t.ended_at === null;
      let status = b.status,
        expiry = b.expires_at;
      if (
        complete &&
        [
          "READY",
          "LIVE",
          "PARTIAL_DELIVERY",
          "FAILED_SERVICE",
          "EXPIRED",
        ].includes(b.status)
      )
        status = "COMPLETED";
      else if (canStart) {
        status = "LIVE";
        expiry = deadline;
      }
      const marker = crypto.randomUUID();
      const guard =
        "EXISTS(SELECT 1 FROM mp_session_timing WHERE booking_id=? AND reconcile_token=?)";
      const commands = [
        statement(
          "UPDATE mp_session_timing SET started_at=?,overlap_ms=?,revision=revision+1,reconcile_token=? WHERE booking_id=? AND revision=?",
          started,
          overlap,
          marker,
          bookingId,
          t.revision,
        ),
        statement(
          "UPDATE mp_bookings SET status=?,expires_at=?,updated_at=? WHERE id=? AND status=? AND " +
            guard,
          status,
          expiry,
          clock(),
          bookingId,
          b.status,
          bookingId,
          marker,
        ),
        statement(
          "UPDATE mp_host_claims SET expires_at=? WHERE booking_id=? AND " +
            guard,
          expiry,
          bookingId,
          bookingId,
          marker,
        ),
      ];
      if (status === "COMPLETED") {
        commands.push(
          statement(
            "DELETE FROM mp_host_claims WHERE booking_id=? AND " + guard,
            bookingId,
            bookingId,
            marker,
          ),
        );
        commands.push(
          statement(
            "UPDATE mp_video_rooms SET status='CLOSING' WHERE booking_id=? AND status='READY' AND " +
              guard,
            bookingId,
            bookingId,
            marker,
          ),
        );
        if (payment?.status === "CAPTURED") {
          const share = allocationFor(
            payment.amount_cents,
            JSON.parse(b.quote).hostShareBasisPoints,
          );
          for (const [account, debit, credit] of [
            ["service_liability", payment.amount_cents, 0],
            ["host_base_payable", 0, share.hostCents],
            ["platform_revenue", 0, share.platformCents],
          ]) {
            if (debit === 0 && credit === 0) continue;
            commands.push(
              statement(
                "INSERT OR IGNORE INTO mp_ledger_entries(id,booking_id,payment_id,event_id,account,debit_cents,credit_cents,created_at) SELECT ?,?,?,?,?,?,?,? WHERE " +
                  guard +
                  " AND EXISTS(SELECT 1 FROM mp_bookings WHERE id=? AND status='COMPLETED')",
                crypto.randomUUID(),
                bookingId,
                payment.id,
                "delivery:" + payment.id,
                account,
                debit,
                credit,
                clock(),
                bookingId,
                marker,
                bookingId,
              ),
            );
          }
        }
      }
      const result = await db.batch(commands);
      if (result[0].meta.changes === 1)
        return { status, overlapMs: overlap, startedAt: started, deadline };
    }
    throw new Error(
      "Session evidence changed concurrently. Retry reconciliation.",
    );
  }
  async function ingest(event) {
    if (event?.test) return { verified: true };
    need(
      ["participant.joined", "participant.left"].includes(event?.type),
      "EVENT_UNSUPPORTED",
      "This provider event is not used for attendance.",
      400,
    );
    const p = event.payload;
    need(
      typeof p?.room === "string" &&
        typeof p.session_id === "string" &&
        p.session_id.length <= 128 &&
        typeof p.user_id === "string" &&
        Number.isFinite(p.joined_at),
      "INVALID_EVENT",
      "A participant-bound provider event is required.",
      400,
    );
    const room = await first(
      "SELECT * FROM mp_video_rooms WHERE room_name=?",
      p.room,
    );
    if (!room) return { ignored: true };
    const b = await first(
      "SELECT * FROM mp_bookings WHERE id=?",
      room.booking_id,
    );
    need(
      [b.customer_id, b.host_id].includes(p.user_id),
      "UNEXPECTED_PARTICIPANT",
      "The event participant does not belong to this room.",
      400,
    );
    const joinedAt = Math.round(p.joined_at * 1000);
    const leftAt =
      event.type === "participant.left"
        ? Math.round((p.joined_at + p.duration) * 1000)
        : null;
    need(
      Number.isSafeInteger(joinedAt) &&
        joinedAt >= room.created_at - 5000 &&
        joinedAt <= clock() + 10000 &&
        (leftAt === null ||
          (Number.isSafeInteger(leftAt) &&
            leftAt >= joinedAt &&
            leftAt <= clock() + 10000)),
      "INVALID_EVENT",
      "Provider attendance time is invalid.",
      400,
    );
    const eventId = event.type + ":" + p.session_id;
    const commands = [
      statement(
        "INSERT OR IGNORE INTO mp_provider_events(id,provider,booking_id,kind,occurred_at,received_at) VALUES(?,'daily',?,?,?,?)",
        eventId,
        b.id,
        event.type,
        leftAt ?? joinedAt,
        clock(),
      ),
      statement(
        "INSERT INTO mp_session_presence(booking_id,session_id,user_id,joined_at,left_at) VALUES(?,?,?,?,?) ON CONFLICT(booking_id,session_id) DO UPDATE SET left_at=COALESCE(mp_session_presence.left_at,excluded.left_at) WHERE mp_session_presence.user_id=excluded.user_id AND mp_session_presence.joined_at=excluded.joined_at",
        b.id,
        p.session_id,
        p.user_id,
        joinedAt,
        leftAt,
      ),
    ];
    await db.batch(commands);
    await reconcile(b.id);
    return { received: true };
  }
  async function endSession(actor, bookingId, reason = "USER_ENDED") {
    const b = await owned(actor, bookingId);
    need(
      ["USER_ENDED", "SAFETY"].includes(reason),
      "INVALID_STATE",
      "Choose an end reason.",
      400,
    );
    if (
      !active.includes(b.status) &&
      !(reason === "SAFETY" && b.status === "SAFETY_ENDED")
    )
      return read(actor, b.id);
    const now = clock();
    await timing(b.id);
    const status = reason === "SAFETY" ? "SAFETY_ENDED" : "PARTIAL_DELIVERY";
    await db.batch([
      statement(
        "UPDATE mp_session_timing SET ended_at=COALESCE(ended_at,?),reason=COALESCE(reason,?),revision=revision+1 WHERE booking_id=?",
        now,
        reason,
        b.id,
      ),
      statement(
        "UPDATE mp_bookings SET status=?,updated_at=? WHERE id=? AND status IN ('READY','LIVE')",
        status,
        now,
        b.id,
      ),
      statement("DELETE FROM mp_host_claims WHERE booking_id=?", b.id),
      statement(
        "UPDATE mp_video_rooms SET status='CLOSING' WHERE booking_id=? AND status IN ('PROVISIONING','READY')",
        b.id,
      ),
      statement(
        "INSERT OR IGNORE INTO mp_refunds(id,booking_id,payment_id,reason,status,created_at,updated_at) SELECT ?,booking_id,id,?,'OPEN',?,? FROM mp_payments WHERE booking_id=? AND status='CAPTURED'",
        crypto.randomUUID(),
        "The session ended before confirmed full delivery. Review required.",
        now,
        now,
        b.id,
      ),
    ]);
    await reconcile(b.id);
    await cleanup(b.id);
    return read(actor, b.id);
  }
  async function cleanup(bookingId) {
    if (!videoProvider) return;
    const rows = (
      await statement(
        "SELECT * FROM mp_video_rooms WHERE status='CLOSING' AND cleanup_attempts<10" +
          (bookingId ? " AND booking_id=?" : ""),
        ...(bookingId ? [bookingId] : []),
      ).all()
    ).results;
    for (const room of rows) {
      await statement(
        "UPDATE mp_video_rooms SET cleanup_attempts=cleanup_attempts+1 WHERE booking_id=?",
        room.booking_id,
      ).run();
      try {
        await videoProvider.deleteRoom(room.room_name);
        await statement(
          "UPDATE mp_video_rooms SET status='CLOSED' WHERE booking_id=?",
          room.booking_id,
        ).run();
      } catch {
        /* A subsequent scheduled sweep retries the same private room. */
      }
    }
  }
  async function expire() {
    await statement(
      "UPDATE mp_video_rooms SET status='CLOSING' WHERE status IN ('PROVISIONING','READY') AND (expires_at<=? OR EXISTS(SELECT 1 FROM mp_bookings b WHERE b.id=booking_id AND b.status NOT IN ('REQUESTED','ACCEPTED','READY','LIVE')))",
      clock(),
    ).run();
    const rows = (
      await statement(
        "SELECT b.id FROM mp_bookings b JOIN mp_video_rooms r ON r.booking_id=b.id WHERE b.status IN ('READY','LIVE') AND b.expires_at<=?",
        clock(),
      ).all()
    ).results;
    for (const row of rows) {
      await reconcile(row.id);
      const b = await first("SELECT * FROM mp_bookings WHERE id=?", row.id);
      if (active.includes(b.status) && b.expires_at <= clock()) {
        await timing(b.id);
        await db.batch([
          statement(
            "UPDATE mp_session_timing SET ended_at=COALESCE(ended_at,?),reason=COALESCE(reason,'DEADLINE'),revision=revision+1 WHERE booking_id=?",
            b.expires_at,
            b.id,
          ),
          statement(
            "UPDATE mp_bookings SET status='PARTIAL_DELIVERY',updated_at=? WHERE id=? AND status IN ('READY','LIVE')",
            clock(),
            b.id,
          ),
          statement("DELETE FROM mp_host_claims WHERE booking_id=?", b.id),
          statement(
            "UPDATE mp_video_rooms SET status='CLOSING' WHERE booking_id=?",
            b.id,
          ),
          statement(
            "INSERT OR IGNORE INTO mp_refunds(id,booking_id,payment_id,reason,status,created_at,updated_at) SELECT ?,booking_id,id,'Delivery deadline passed. Provider attendance review required.','OPEN',?,? FROM mp_payments WHERE booking_id=? AND status='CAPTURED'",
            crypto.randomUUID(),
            clock(),
            clock(),
            b.id,
          ),
        ]);
      }
    }
    await cleanup();
  }
  async function read(actor, bookingId) {
    const b = await owned(actor, bookingId),
      t = await timing(b.id);
    const rows = (
      await statement(
        "SELECT user_id,joined_at,left_at FROM mp_session_presence WHERE booking_id=?",
        b.id,
      ).all()
    ).results;
    return {
      bookingId: b.id,
      status: b.status,
      startedAt: t.started_at,
      deadline: b.expires_at,
      overlapMs: t.overlap_ms,
      attendance: rows.map((row) => ({
        userId: row.user_id,
        present: row.left_at === null,
      })),
      roomCleanupPending:
        (
          await first(
            "SELECT status FROM mp_video_rooms WHERE booking_id=?",
            b.id,
          )
        )?.status === "CLOSING",
    };
  }
  return { roomToken, ingest, endSession, expire, read, reconcile };
}
