import { requireCondition as need } from "./errors.mjs";
/**
 * @param {any} db
 * @param {{provider?: ReturnType<typeof import("./providers.mjs").createStripeSandbox>, clock?: () => number}} [options]
 */
export function createPaymentService(db, { provider, clock = Date.now } = {}) {
  const statement = (sql, ...args) => db.prepare(sql).bind(...args);
  async function checkout(actor, bookingId) {
    const account = await statement(
      "SELECT * FROM mp_users WHERE id=?",
      actor.id,
    ).first();
    need(
      account?.status === "ACTIVE",
      "FORBIDDEN",
      "An active customer account is required.",
      403,
    );
    const role = await statement(
      "SELECT role FROM mp_user_roles WHERE user_id=? AND role='customer'",
      actor.id,
    ).first();
    need(role, "FORBIDDEN", "Customer access is required.", 403);
    const b = await statement(
      "SELECT * FROM mp_bookings WHERE id=? AND customer_id=?",
      bookingId,
      actor.id,
    ).first();
    need(b, "NOT_FOUND", "Booking not found.", 404);
    const now = clock();
    need(
      b.status === "ACCEPTED" && b.expires_at > now,
      "BOOKING_EXPIRED",
      "The accepted reservation has expired.",
    );
    need(
      provider?.mode === "sandbox",
      "PROVIDER_UNAVAILABLE",
      "Sandbox checkout is not configured.",
      503,
    );
    const quote = JSON.parse(b.quote);
    need(
      quote.totalCents === b.amount_cents &&
        quote.currency === b.currency &&
        quote.expiresAt > now,
      "QUOTE_EXPIRED",
      "Request a fresh quote before checkout.",
    );
    const existing = await statement(
      "SELECT * FROM mp_payments WHERE booking_id=?",
      b.id,
    ).first();
    need(
      !existing || ["PENDING", "FAILED"].includes(existing.status),
      "ALREADY_PAID",
      "This reservation already has a settled payment.",
    );
    await statement(
      "INSERT OR IGNORE INTO mp_payments(id,booking_id,provider_id,status,amount_cents,currency,created_at,updated_at) VALUES(?,?,?,'PENDING',?,?,?,?)",
      crypto.randomUUID(),
      b.id,
      "pending_" + b.id,
      b.amount_cents,
      b.currency,
      now,
      now,
    ).run();
    // Provider idempotency is stable across devices, lost responses and customer request keys.
    const intent = await provider.createIntent(
      { bookingId: b.id, quote },
      "hc-booking-" + b.id,
    );
    need(
      intent.livemode === false &&
        intent.amount === b.amount_cents &&
        intent.currency === b.currency.toLowerCase() &&
        /^pi_[a-zA-Z0-9_]+$/.test(intent.id),
      "PROVIDER_MISMATCH",
      "The sandbox provider returned a mismatched payment.",
      502,
    );
    await statement(
      "UPDATE mp_payments SET provider_id=?,updated_at=? WHERE booking_id=? AND status IN ('PENDING','FAILED') AND (provider_id=? OR provider_id=?)",
      intent.id,
      now,
      b.id,
      "pending_" + b.id,
      intent.id,
    ).run();
    const saved = await statement(
      "SELECT * FROM mp_payments WHERE booking_id=?",
      b.id,
    ).first();
    need(
      saved.provider_id === intent.id,
      "PAYMENT_CONFLICT",
      "Payment reconciliation is required.",
    );
    const latest = await statement(
      "SELECT * FROM mp_bookings WHERE id=?",
      b.id,
    ).first();
    if (saved.status === "CAPTURED" && latest.status === "READY")
      return {
        bookingId: b.id,
        providerId: intent.id,
        alreadyPaid: true,
        mode: "sandbox",
      };
    const claim = await statement(
      "SELECT booking_id FROM mp_host_claims WHERE booking_id=? AND expires_at>?",
      b.id,
      clock(),
    ).first();
    need(
      latest.status === "ACCEPTED" &&
        latest.expires_at > clock() &&
        quote.expiresAt > clock() &&
        claim,
      "BOOKING_EXPIRED",
      "The reservation changed while checkout was opening. Return to matching.",
    );
    return {
      bookingId: b.id,
      providerId: intent.id,
      clientSecret: intent.client_secret,
      mode: "sandbox",
    };
  }
  async function ingest(event) {
    need(
      event?.livemode === false &&
        typeof event.id === "string" &&
        event.data?.object,
      "INVALID_EVENT",
      "Only verified sandbox events can be applied.",
      400,
    );
    if (
      ![
        "payment_intent.succeeded",
        "payment_intent.payment_failed",
        "charge.refunded",
      ].includes(event.type)
    )
      return { ignored: true };
    const object = event.data.object;
    const providerId =
      event.type === "charge.refunded" ? object.payment_intent : object.id;
    const payment = await statement(
      "SELECT * FROM mp_payments WHERE provider_id=?",
      providerId,
    ).first();
    // Returning a retryable result allows a webhook arriving before checkout persistence to retry.
    need(
      payment,
      "PAYMENT_NOT_RECORDED",
      "The payment is not ready for reconciliation.",
      503,
    );
    need(
      object.currency === payment.currency.toLowerCase() &&
        object.amount === payment.amount_cents,
      "PROVIDER_MISMATCH",
      "Provider amount or currency did not match the quote.",
      400,
    );
    if (event.type === "payment_intent.succeeded")
      need(
        object.amount_received === payment.amount_cents,
        "PROVIDER_MISMATCH",
        "The full expected amount was not received.",
        400,
      );
    if (event.type === "charge.refunded")
      need(
        object.refunded === true &&
          object.amount_refunded === payment.amount_cents,
        "RECONCILIATION_REQUIRED",
        "Partial refunds require a separate reviewed reconciliation workflow.",
        409,
      );
    const b = await statement(
      "SELECT * FROM mp_bookings WHERE id=?",
      payment.booking_id,
    ).first();
    const now = clock(),
      marker = crypto.randomUUID();
    const guard =
      "EXISTS(SELECT 1 FROM mp_webhook_events WHERE id=? AND processing_id=?)";
    const commands = [
      statement(
        "INSERT OR IGNORE INTO mp_webhook_events(id,provider,type,created_at,processing_id) VALUES(?,'stripe',?,?,?)",
        event.id,
        event.type,
        now,
        marker,
      ),
    ];
    const add = (sql, args = []) =>
      commands.push(
        statement(sql + " AND " + guard, ...args, event.id, marker),
      );
    const journal = (name, account, debit, credit) =>
      commands.push(
        statement(
          "INSERT OR IGNORE INTO mp_ledger_entries(id,booking_id,payment_id,event_id,account,debit_cents,credit_cents,created_at) SELECT ?,?,?,?,?,?,?,? WHERE " +
            guard,
          crypto.randomUUID(),
          b.id,
          payment.id,
          name + ":" + payment.id,
          account,
          debit,
          credit,
          now,
          event.id,
          marker,
        ),
      );
    if (event.type === "payment_intent.payment_failed") {
      add(
        "UPDATE mp_payments SET status='FAILED',updated_at=? WHERE id=? AND status='PENDING'",
        [now, payment.id],
      );
    } else {
      // A full-refund event proves its charge existed, including delivery before the success event.
      journal("capture", "processor_clearing", payment.amount_cents, 0);
      journal("capture", "service_liability", 0, payment.amount_cents);
      if (event.type === "charge.refunded") {
        add(
          "UPDATE mp_payments SET status='REFUNDED',updated_at=? WHERE id=?",
          [now, payment.id],
        );
        journal("refund", "service_liability", payment.amount_cents, 0);
        journal("refund", "processor_clearing", 0, payment.amount_cents);
        commands.push(
          statement(
            "INSERT OR IGNORE INTO mp_refunds(id,booking_id,payment_id,reason,status,created_at,updated_at) SELECT ?,?,?,?,'REFUNDED',?,? WHERE " +
              guard,
            crypto.randomUUID(),
            b.id,
            payment.id,
            "Provider confirmed a full sandbox refund.",
            now,
            now,
            event.id,
            marker,
          ),
        );
        add(
          "UPDATE mp_refunds SET status='REFUNDED',updated_at=? WHERE payment_id=?",
          [now, payment.id],
        );
        add(
          "UPDATE mp_bookings SET status=CASE WHEN status='LIVE' THEN 'PARTIAL_DELIVERY' ELSE 'CANCELLED' END,updated_at=? WHERE id=? AND status IN ('REQUESTED','ACCEPTED','READY','LIVE')",
          [now, b.id],
        );
        add("DELETE FROM mp_host_claims WHERE booking_id=?", [b.id]);
      } else {
        add(
          "UPDATE mp_payments SET status='CAPTURED',updated_at=? WHERE id=? AND status IN ('PENDING','FAILED')",
          [now, payment.id],
        );
        add(
          "UPDATE mp_bookings SET status='EXPIRED',updated_at=? WHERE id=? AND status='ACCEPTED' AND expires_at<=?",
          [now, b.id, now],
        );
        add(
          "DELETE FROM mp_host_claims WHERE booking_id=? AND EXISTS(SELECT 1 FROM mp_bookings WHERE id=? AND status='EXPIRED')",
          [b.id, b.id],
        );
        add(
          "UPDATE mp_bookings SET status='READY',expires_at=?,updated_at=? WHERE id=? AND status='ACCEPTED' AND expires_at>? AND EXISTS(SELECT 1 FROM mp_payments WHERE id=? AND status='CAPTURED')",
          [now + 180_000, now, b.id, now, payment.id],
        );
        add(
          "UPDATE mp_host_claims SET expires_at=? WHERE booking_id=? AND EXISTS(SELECT 1 FROM mp_bookings WHERE id=? AND status='READY')",
          [now + 180_000, b.id, b.id],
        );
        commands.push(
          statement(
            "INSERT OR IGNORE INTO mp_refunds(id,booking_id,payment_id,reason,status,created_at,updated_at) SELECT ?,?,?,?,'OPEN',?,? WHERE " +
              guard +
              " AND EXISTS(SELECT 1 FROM mp_bookings WHERE id=? AND status IN ('DECLINED','EXPIRED','CANCELLED','FAILED_SERVICE','SAFETY_ENDED','PARTIAL_DELIVERY')) AND EXISTS(SELECT 1 FROM mp_payments WHERE id=? AND status='CAPTURED')",
            crypto.randomUUID(),
            b.id,
            payment.id,
            "Sandbox payment arrived after delivery became unavailable.",
            now,
            now,
            event.id,
            marker,
            b.id,
            payment.id,
          ),
        );
      }
    }
    await db.batch(commands);
    const receipt = await statement(
      "SELECT processing_id FROM mp_webhook_events WHERE id=?",
      event.id,
    ).first();
    return {
      received: true,
      replayed: receipt.processing_id !== marker,
      paymentId: payment.id,
    };
  }
  return { checkout, ingest };
}
