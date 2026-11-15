import { requireCondition as need } from "./errors.mjs";
import { fingerprint } from "../fingerprint.mjs";
/**
 * @param {any} db
 * @param {{provider?: ReturnType<typeof import("./providers.mjs").createStripeSandbox>, clock?: () => number}} [options]
 */
export function createPaymentService(db, { provider, clock = Date.now } = {}) {
  const statement = (sql, ...args) => db.prepare(sql).bind(...args);
  async function financeActor(actor) {
    const allowed = await statement(
      "SELECT u.status FROM mp_users u JOIN mp_user_roles r ON r.user_id=u.id WHERE u.id=? AND r.role IN ('finance','admin')",
      actor?.id || "",
    ).first();
    need(
      allowed?.status === "ACTIVE" && actor.stepUp === true,
      "FORBIDDEN",
      "A recent multi-factor finance sign-in is required.",
      403,
    );
  }
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
        "charge.dispute.created",
        "charge.dispute.updated",
        "charge.dispute.closed",
      ].includes(event.type)
    )
      return { ignored: true };
    const object = event.data.object;
    if (event.type.startsWith("charge.dispute.")) return ingestDispute(event);
    const providerId =
      event.type === "charge.refunded" ? object.payment_intent : object.id;
    const tipRecord = await statement(
      "SELECT * FROM mp_tips WHERE provider_id=?",
      providerId,
    ).first();
    if (tipRecord) return ingestTip(event, tipRecord);
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
      return ingestBaseRefund(event, payment);
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
      {
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
  async function ingestBaseRefund(event, payment) {
    const object = event.data.object,
      cumulative = object.amount_refunded;
    need(
      Number.isSafeInteger(cumulative) &&
        cumulative > 0 &&
        cumulative <= payment.amount_cents &&
        payment.amount_cents <= 99999999 &&
        object.refunded === (cumulative === payment.amount_cents),
      "PROVIDER_MISMATCH",
      "The cumulative refund does not match the charge.",
      400,
    );
    const now = clock(),
      marker = crypto.randomUUID();
    const owned =
      "EXISTS(SELECT 1 FROM mp_webhook_events WHERE id=? AND processing_id=?)";
    const step =
      "EXISTS(SELECT 1 FROM mp_refund_steps WHERE event_id=? AND payment_id=?)";
    const commands = [
      statement(
        "INSERT OR IGNORE INTO mp_webhook_events(id,provider,type,created_at,processing_id) VALUES(?,'stripe',?,?,?)",
        event.id,
        event.type,
        now,
        marker,
      ),
      statement(
        "INSERT OR IGNORE INTO mp_payment_refund_totals(payment_id,refunded_cents,updated_at) VALUES(?,0,?)",
        payment.id,
        now,
      ),
      statement(
        "INSERT OR IGNORE INTO mp_refund_steps(event_id,payment_id,previous_cents,cumulative_cents,created_at) SELECT ?,payment_id,refunded_cents,?,? FROM mp_payment_refund_totals WHERE payment_id=? AND refunded_cents<? AND " +
          owned,
        event.id,
        cumulative,
        now,
        payment.id,
        cumulative,
        event.id,
        marker,
      ),
    ];
    const journal = (
      name,
      account,
      debit,
      credit,
      condition = owned,
      args = [event.id, marker],
    ) =>
      commands.push(
        statement(
          "INSERT OR IGNORE INTO mp_ledger_entries(id,booking_id,payment_id,event_id,account,debit_cents,credit_cents,created_at) SELECT ?,?,?,?,?,?,?,? WHERE " +
            condition,
          crypto.randomUUID(),
          payment.booking_id,
          payment.id,
          name + ":" + payment.id,
          account,
          debit,
          credit,
          now,
          ...args,
        ),
      );
    journal("capture", "processor_clearing", payment.amount_cents, 0);
    journal("capture", "service_liability", 0, payment.amount_cents);
    // Read the previous high-water mark inside this same transaction. Callbacks can
    // race, repeat or arrive out of order without applying a reversal twice.
    const delivered =
      "EXISTS(SELECT 1 FROM mp_ledger_entries WHERE event_id='delivery:'||?)";
    const hostTotal =
      "COALESCE((SELECT credit_cents FROM mp_ledger_entries WHERE event_id='delivery:'||? AND account='host_base_payable'),0)";
    const hostDelta =
      "CAST((s.cumulative_cents*" +
      hostTotal +
      "+CAST(? AS INTEGER) / 2)/CAST(? AS INTEGER) AS INTEGER)-CAST((s.previous_cents*" +
      hostTotal +
      "+CAST(? AS INTEGER) / 2)/CAST(? AS INTEGER) AS INTEGER)";
    const hostArgs = [
      payment.id,
      payment.amount_cents,
      payment.amount_cents,
      payment.id,
      payment.amount_cents,
      payment.amount_cents,
    ];
    const lines = [
      [
        "service_liability",
        "s.cumulative_cents-s.previous_cents",
        [],
        "NOT " + delivered,
        [payment.id],
        true,
      ],
      ["host_base_payable", hostDelta, hostArgs, delivered, [payment.id], true],
      [
        "platform_revenue",
        "s.cumulative_cents-s.previous_cents-(" + hostDelta + ")",
        hostArgs,
        delivered,
        [payment.id],
        true,
      ],
      [
        "processor_clearing",
        "s.cumulative_cents-s.previous_cents",
        [],
        "1=1",
        [],
        false,
      ],
    ];
    for (const [
      account,
      amount,
      args,
      condition,
      conditionArgs,
      debit,
    ] of lines)
      commands.push(
        statement(
          "INSERT OR IGNORE INTO mp_ledger_entries(id,booking_id,payment_id,event_id,account,debit_cents,credit_cents,created_at) SELECT ?,?,?,?,?," +
            (debit ? "n,0" : "0,n") +
            ",? FROM (SELECT " +
            amount +
            " n FROM mp_refund_steps s WHERE event_id=? AND " +
            condition +
            ") WHERE n>0 AND " +
            owned,
          crypto.randomUUID(),
          payment.booking_id,
          payment.id,
          "refund:" + payment.id + ":" + cumulative,
          account,
          now,
          ...args,
          event.id,
          ...conditionArgs,
          event.id,
          marker,
        ),
      );
    commands.push(
      statement(
        "UPDATE mp_payment_refund_totals SET refunded_cents=?,updated_at=? WHERE payment_id=? AND refunded_cents<? AND " +
          step,
        cumulative,
        now,
        payment.id,
        cumulative,
        event.id,
        payment.id,
      ),
      statement(
        "UPDATE mp_payments SET status=CASE WHEN ?=amount_cents THEN 'REFUNDED' WHEN status IN ('PENDING','FAILED') THEN 'CAPTURED' ELSE status END,updated_at=? WHERE id=? AND " +
          step,
        cumulative,
        now,
        payment.id,
        event.id,
        payment.id,
      ),
      statement(
        "INSERT OR IGNORE INTO mp_refunds(id,booking_id,payment_id,reason,status,created_at,updated_at) SELECT ?,?,?,'Provider confirmed a sandbox refund.','REFUNDED',?,? WHERE " +
          step,
        crypto.randomUUID(),
        payment.booking_id,
        payment.id,
        now,
        now,
        event.id,
        payment.id,
      ),
      statement(
        "UPDATE mp_refund_awards SET status='CONFIRMED',updated_at=? WHERE payment_id=? AND cumulative_target<=? AND " +
          step,
        now,
        payment.id,
        cumulative,
        event.id,
        payment.id,
      ),
      statement(
        "UPDATE mp_refunds SET status='REFUNDED',updated_at=? WHERE payment_id=? AND " +
          step +
          " AND NOT EXISTS(SELECT 1 FROM mp_refund_awards WHERE payment_id=? AND status<>'CONFIRMED')",
        now,
        payment.id,
        event.id,
        payment.id,
        payment.id,
      ),
      statement(
        "UPDATE mp_bookings SET status=CASE WHEN status='LIVE' THEN 'PARTIAL_DELIVERY' ELSE 'CANCELLED' END,updated_at=? WHERE id=? AND status IN ('REQUESTED','ACCEPTED','READY','LIVE') AND " +
          step,
        now,
        payment.booking_id,
        event.id,
        payment.id,
      ),
      statement(
        "DELETE FROM mp_host_claims WHERE booking_id=? AND " + step,
        payment.booking_id,
        event.id,
        payment.id,
      ),
      statement(
        "UPDATE mp_video_rooms SET status='CLOSING' WHERE booking_id=? AND status='READY' AND " +
          step,
        payment.booking_id,
        event.id,
        payment.id,
      ),
    );
    await db.batch(commands);
    const receipt = await statement(
      "SELECT processing_id FROM mp_webhook_events WHERE id=?",
      event.id,
    ).first();
    const totals = await statement(
      "SELECT refunded_cents FROM mp_payment_refund_totals WHERE payment_id=?",
      payment.id,
    ).first();
    return {
      received: true,
      replayed: receipt.processing_id !== marker,
      paymentId: payment.id,
      refundedCents: totals.refunded_cents,
    };
  }
  async function tip(actor, bookingId, cents, key) {
    need(
      Number.isSafeInteger(cents) &&
        cents >= 100 &&
        cents <= 10000 &&
        typeof key === "string" &&
        key.length > 0 &&
        key.length <= 128,
      "VALIDATION",
      "Choose an optional tip from $1 to $100 and provide an idempotency key.",
      400,
    );
    const b = await statement(
      "SELECT b.*,p.status payment_status FROM mp_bookings b JOIN mp_payments p ON p.booking_id=b.id JOIN mp_users u ON u.id=b.customer_id WHERE b.id=? AND b.customer_id=? AND u.status='ACTIVE'",
      bookingId,
      actor.id,
    ).first();
    need(
      b?.status === "COMPLETED" && b.payment_status === "CAPTURED",
      "TIP_INELIGIBLE",
      "Tips require your fully delivered, paid session.",
    );
    need(
      provider?.mode === "sandbox" && provider.createTipIntent,
      "PROVIDER_UNAVAILABLE",
      "Sandbox tips are not configured.",
      503,
    );
    const digest = fingerprint(JSON.stringify({ bookingId, cents }));
    await statement(
      "INSERT OR IGNORE INTO mp_tips(id,booking_id,customer_id,provider_id,amount_cents,request_key,fingerprint,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'PENDING',?,?)",
      crypto.randomUUID(),
      b.id,
      actor.id,
      "pending_tip_" + b.id,
      cents,
      key,
      digest,
      clock(),
      clock(),
    ).run();
    const saved = await statement(
      "SELECT * FROM mp_tips WHERE booking_id=?",
      b.id,
    ).first();
    need(
      saved.fingerprint === digest,
      "TIP_EXISTS",
      "This session already has a different tip.",
    );
    if (saved.status !== "PENDING")
      return { bookingId: b.id, status: saved.status, alreadySubmitted: true };
    const intent = await provider.createTipIntent(
      { bookingId: b.id, tipId: saved.id, amountCents: saved.amount_cents },
      "hc-tip-" + saved.id,
    );
    need(
      intent.livemode === false &&
        intent.amount === saved.amount_cents &&
        intent.currency === "usd",
      "PROVIDER_MISMATCH",
      "The provider returned a different tip.",
      502,
    );
    await statement(
      "UPDATE mp_tips SET provider_id=?,updated_at=? WHERE id=? AND status='PENDING'",
      intent.id,
      clock(),
      saved.id,
    ).run();
    const current = await statement(
      "SELECT status FROM mp_payments WHERE booking_id=?",
      b.id,
    ).first();
    need(
      current.status === "CAPTURED",
      "TIP_INELIGIBLE",
      "The base payment changed while the tip was opening.",
    );
    return {
      bookingId: b.id,
      clientSecret: intent.client_secret,
      providerId: intent.id,
      mode: "sandbox",
    };
  }
  async function ingestTip(event, tipRecord) {
    const object = event.data.object;
    need(
      object.amount === tipRecord.amount_cents && object.currency === "usd",
      "PROVIDER_MISMATCH",
      "Tip amount or currency did not match.",
      400,
    );
    if (event.type === "payment_intent.payment_failed")
      return { received: true };
    const isRefund = event.type === "charge.refunded";
    const cumulative = isRefund ? object.amount_refunded : 0;
    need(
      isRefund
        ? Number.isSafeInteger(cumulative) &&
            cumulative > 0 &&
            cumulative <= tipRecord.amount_cents &&
            object.refunded === (cumulative === tipRecord.amount_cents)
        : object.amount_received === tipRecord.amount_cents,
      "PROVIDER_MISMATCH",
      "Tip capture or cumulative refund does not match.",
      400,
    );
    const payment = await statement(
      "SELECT * FROM mp_payments WHERE booking_id=?",
      tipRecord.booking_id,
    ).first();
    const marker = crypto.randomUUID(),
      now = clock();
    const guard =
      "EXISTS(SELECT 1 FROM mp_webhook_events WHERE id=? AND processing_id=?)";
    const commands = [
      statement(
        "INSERT OR IGNORE INTO mp_webhook_events(id,provider,type,processing_id,created_at) VALUES(?,'stripe',?,?,?)",
        event.id,
        event.type,
        marker,
        now,
      ),
    ];
    const ledger = (name, account, debit, credit) =>
      commands.push(
        statement(
          "INSERT OR IGNORE INTO mp_ledger_entries(id,booking_id,payment_id,event_id,account,debit_cents,credit_cents,created_at) SELECT ?,?,?,?,?,?,?,? WHERE " +
            guard,
          crypto.randomUUID(),
          tipRecord.booking_id,
          payment.id,
          name + ":" + tipRecord.id,
          account,
          debit,
          credit,
          now,
          event.id,
          marker,
        ),
      );
    ledger("tip-capture", "processor_clearing", tipRecord.amount_cents, 0);
    ledger("tip-capture", "host_tip_payable", 0, tipRecord.amount_cents);
    if (isRefund) {
      commands.push(
        statement(
          "INSERT OR IGNORE INTO mp_tip_refund_totals(tip_id,refunded_cents,updated_at) VALUES(?,0,?)",
          tipRecord.id,
          now,
        ),
        statement(
          "INSERT OR IGNORE INTO mp_tip_refund_steps(event_id,tip_id,previous_cents,cumulative_cents,created_at) SELECT ?,tip_id,refunded_cents,?,? FROM mp_tip_refund_totals WHERE tip_id=? AND refunded_cents<? AND " +
            guard,
          event.id,
          cumulative,
          now,
          tipRecord.id,
          cumulative,
          event.id,
          marker,
        ),
      );
      for (const [account, debit] of [
        ["host_tip_payable", true],
        ["processor_clearing", false],
      ])
        commands.push(
          statement(
            "INSERT OR IGNORE INTO mp_ledger_entries(id,booking_id,payment_id,event_id,account,debit_cents,credit_cents,created_at) SELECT ?,?,?,?,?, " +
              (debit ? "n,0" : "0,n") +
              ",? FROM (SELECT cumulative_cents-previous_cents n FROM mp_tip_refund_steps WHERE event_id=?) WHERE n>0 AND " +
              guard,
            crypto.randomUUID(),
            tipRecord.booking_id,
            payment.id,
            "tip-refund:" + tipRecord.id + ":" + cumulative,
            account,
            now,
            event.id,
            event.id,
            marker,
          ),
        );
      commands.push(
        statement(
          "UPDATE mp_tip_refund_totals SET refunded_cents=?,updated_at=? WHERE tip_id=? AND refunded_cents<? AND EXISTS(SELECT 1 FROM mp_tip_refund_steps WHERE event_id=?)",
          cumulative,
          now,
          tipRecord.id,
          cumulative,
          event.id,
        ),
        statement(
          "UPDATE mp_tips SET status=CASE WHEN ?=amount_cents THEN 'REFUNDED' ELSE 'CAPTURED' END,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM mp_tip_refund_steps WHERE event_id=? AND tip_id=?) AND " +
            guard,
          cumulative,
          now,
          tipRecord.id,
          event.id,
          tipRecord.id,
          event.id,
          marker,
        ),
      );
    } else
      commands.push(
        statement(
          "UPDATE mp_tips SET status='CAPTURED',updated_at=? WHERE id=? AND status<>'REFUNDED' AND " +
            guard,
          now,
          tipRecord.id,
          event.id,
          marker,
        ),
      );
    await db.batch(commands);
    return { received: true, tipId: tipRecord.id };
  }
  async function reviewRefund(actor, payload, key) {
    await financeActor(actor);
    need(
      typeof key === "string" &&
        key.length > 0 &&
        key.length <= 128 &&
        ["APPROVED", "REJECTED"].includes(payload.status) &&
        typeof payload.reason === "string" &&
        payload.reason.trim().length > 0 &&
        payload.reason.length <= 2000,
      "VALIDATION",
      "Choose a decision, explanation and request key.",
      400,
    );
    const decision = await statement(
      "SELECT * FROM mp_refund_decisions WHERE reviewer_id=? AND request_key=?",
      actor.id,
      key,
    ).first();
    const prior = decision ? JSON.parse(decision.response) : null;
    const r = await statement(
      "SELECT r.*,p.amount_cents,p.status payment_status,COALESCE(t.refunded_cents,0) refunded_cents FROM mp_refunds r JOIN mp_payments p ON p.id=r.payment_id LEFT JOIN mp_payment_refund_totals t ON t.payment_id=p.id WHERE r.id=?",
      payload.refundId,
    ).first();
    need(r, "NOT_FOUND", "Refund review not found.", 404);
    const cents =
      payload.amountCents ??
      prior?.amountCents ??
      r.amount_cents - r.refunded_cents;
    const digest = fingerprint(
      JSON.stringify({
        refundId: payload.refundId,
        status: payload.status,
        reason: payload.reason.trim(),
        cents: payload.status === "APPROVED" ? cents : 0,
      }),
    );
    if (prior) {
      need(
        decision.fingerprint === digest,
        "IDEMPOTENCY_CONFLICT",
        "This request key was used for another decision.",
      );
      return { ...prior, replayed: true };
    }
    need(
      r.status === "OPEN",
      "INVALID_STATE",
      "This refund review is no longer open.",
    );
    need(
      r.payment_status === "CAPTURED",
      "INVALID_STATE",
      "Only a captured, undisputed payment can be reviewed.",
    );
    if (payload.status === "APPROVED")
      need(
        Number.isSafeInteger(cents) &&
          cents > 0 &&
          cents <= r.amount_cents - r.refunded_cents,
        "VALIDATION",
        "Choose an amount within the remaining paid principal.",
        400,
      );
    const now = clock(),
      id = crypto.randomUUID();
    const commands = [];
    if (payload.status === "APPROVED")
      commands.push(
        statement(
          "INSERT INTO mp_refund_awards(id,refund_id,payment_id,amount_cents,cumulative_target,reviewer_id,reason,request_key,fingerprint,status,created_at,updated_at) SELECT ?,r.id,p.id,?,COALESCE(t.refunded_cents,0)+?,?,?,?,?,'APPROVED',?,? FROM mp_refunds r JOIN mp_payments p ON p.id=r.payment_id LEFT JOIN mp_payment_refund_totals t ON t.payment_id=p.id WHERE r.id=? AND r.status='OPEN' AND p.status='CAPTURED' AND ?<=p.amount_cents-COALESCE(t.refunded_cents,0) AND NOT EXISTS(SELECT 1 FROM mp_refund_awards a WHERE a.payment_id=p.id AND a.status<>'CONFIRMED')",
          id,
          cents,
          cents,
          actor.id,
          payload.reason.trim(),
          key,
          digest,
          now,
          now,
          r.id,
          cents,
        ),
      );
    commands.push(
      statement(
        "INSERT INTO mp_audit_events(id,actor_id,subject_id,action,details,created_at) SELECT ?,?,?,'refund-decision',?,? WHERE EXISTS(SELECT 1 FROM mp_refunds WHERE id=? AND status='OPEN')" +
          (payload.status === "APPROVED"
            ? " AND EXISTS(SELECT 1 FROM mp_refund_awards WHERE id=?)"
            : ""),
        id,
        actor.id,
        r.id,
        JSON.stringify({
          status: payload.status,
          amountCents: payload.status === "APPROVED" ? cents : 0,
          reason: payload.reason.trim(),
        }),
        now,
        r.id,
        ...(payload.status === "APPROVED" ? [id] : []),
      ),
    );
    commands.push(
      statement(
        "UPDATE mp_refunds SET status=?,reviewer_id=?,resolution=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM mp_audit_events WHERE id=?)",
        payload.status,
        actor.id,
        payload.reason.trim(),
        now,
        r.id,
        id,
      ),
    );
    const response = {
      status: payload.status,
      amountCents: payload.status === "APPROVED" ? cents : 0,
      awardId: payload.status === "APPROVED" ? id : null,
      providerRefundPending: payload.status === "APPROVED",
    };
    commands.push(
      statement(
        "INSERT INTO mp_refund_decisions(reviewer_id,request_key,fingerprint,response,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mp_audit_events WHERE id=?)",
        actor.id,
        key,
        digest,
        JSON.stringify(response),
        now,
        id,
      ),
    );
    const result = await db.batch(commands);
    need(
      result[result.length - 2].meta.changes === 1,
      "INVALID_STATE",
      "This refund review changed while the decision was saving.",
    );
    return response;
  }
  async function dispatchRefund(actor, refundId) {
    await financeActor(actor);
    return dispatchApprovedRefund(refundId, actor.id);
  }
  async function dispatchApprovedRefund(refundId, fallbackReviewer) {
    need(
      provider?.mode === "sandbox",
      "PROVIDER_UNAVAILABLE",
      "Sandbox refund processing is not configured.",
      503,
    );
    let award = await statement(
      "SELECT * FROM mp_refund_awards WHERE id=? OR refund_id=? ORDER BY CASE status WHEN 'APPROVED' THEN 0 WHEN 'SUBMITTED' THEN 1 ELSE 2 END,created_at DESC LIMIT 1",
      refundId,
      refundId,
    ).first();
    const r = await statement(
      "SELECT r.*,p.provider_id,p.amount_cents,p.status payment_status,COALESCE(t.refunded_cents,0) refunded_cents FROM mp_refunds r JOIN mp_payments p ON p.id=r.payment_id LEFT JOIN mp_payment_refund_totals t ON t.payment_id=p.id WHERE r.id=?",
      award?.refund_id || refundId,
    ).first();
    need(
      r && ["APPROVED", "REFUNDED"].includes(r.status),
      "INVALID_STATE",
      "Approve the refund before provider submission.",
    );
    if (r.status === "REFUNDED" || award?.status === "CONFIRMED")
      return { alreadySubmitted: true, status: "REFUNDED" };
    const now = clock();
    if (!award) {
      // Compatibility for reviews approved before per-award amounts were introduced.
      need(
        fallbackReviewer || r.reviewer_id,
        "INVALID_STATE",
        "Finance review ownership is required.",
      );
      const cents = r.amount_cents - r.refunded_cents;
      need(
        cents > 0 && r.payment_status === "CAPTURED",
        "INVALID_STATE",
        "No undisputed principal remains to refund.",
      );
      await statement(
        "INSERT OR IGNORE INTO mp_refund_awards(id,refund_id,payment_id,amount_cents,cumulative_target,reviewer_id,reason,request_key,fingerprint,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'APPROVED',?,?)",
        r.id,
        r.id,
        r.payment_id,
        cents,
        r.amount_cents,
        fallbackReviewer || r.reviewer_id,
        r.resolution || "Previously approved full refund.",
        "legacy-refund:" + r.id,
        "legacy:" + r.id,
        now,
        now,
      ).run();
      award = await statement(
        "SELECT * FROM mp_refund_awards WHERE id=?",
        r.id,
      ).first();
    }
    need(
      r.payment_status === "CAPTURED",
      "INVALID_STATE",
      "Refund submission is paused for a disputed or reversed payment.",
    );
    need(
      award.status === "SUBMITTED" ||
        r.refunded_cents === award.cumulative_target - award.amount_cents,
      "RECONCILIATION_REQUIRED",
      "An external refund changed the principal after approval. Finance reconciliation is required.",
    );
    await statement(
      "INSERT OR IGNORE INTO mp_financial_jobs(id,payment_id,kind,reference_id,status,available_at,created_at) VALUES(?,?,'REFUND',?,'PENDING',?,?)",
      crypto.randomUUID(),
      r.payment_id,
      award.id,
      now,
      now,
    ).run();
    const job = await statement(
      "SELECT * FROM mp_financial_jobs WHERE kind='REFUND' AND reference_id=?",
      award.id,
    ).first();
    if (job.status === "SUCCEEDED")
      return { alreadySubmitted: true, awaitingProvider: true };
    const lease = await statement(
      "UPDATE mp_financial_jobs SET status='PROCESSING',lease_until=?,attempts=attempts+1 WHERE id=? AND status<>'SUCCEEDED' AND attempts<8 AND lease_until<=? AND available_at<=?",
      now + 30000,
      job.id,
      now,
      now,
    ).run();
    need(
      lease.meta.changes === 1,
      "JOB_BUSY",
      "This refund is processing or waiting for its retry window.",
    );
    try {
      const response = await provider.refund(
        { paymentIntentId: r.provider_id, amountCents: award.amount_cents },
        "hc-refund-" + award.id,
      );
      need(
        response.livemode === false &&
          response.amount === award.amount_cents &&
          response.payment_intent === r.provider_id &&
          typeof response.id === "string" &&
          /^re_[a-zA-Z0-9_]+$/.test(response.id),
        "PROVIDER_MISMATCH",
        "The provider returned a different refund.",
        502,
      );
      await db.batch([
        statement(
          "UPDATE mp_financial_jobs SET status='SUCCEEDED',lease_until=0,last_error=NULL WHERE id=?",
          job.id,
        ),
        statement(
          "UPDATE mp_refund_awards SET status=CASE WHEN status='CONFIRMED' THEN status ELSE 'SUBMITTED' END,provider_id=?,updated_at=? WHERE id=?",
          response.id,
          clock(),
          award.id,
        ),
      ]);
      return {
        submitted: true,
        awaitingProvider: true,
        providerId: response.id,
        amountCents: award.amount_cents,
      };
    } catch (error) {
      await statement(
        "UPDATE mp_financial_jobs SET status='FAILED',lease_until=0,available_at=?,last_error='Provider submission failed' WHERE id=?",
        now + Math.min(3600000, 1000 * 2 ** job.attempts),
        job.id,
      ).run();
      throw error;
    }
  }
  async function reconcile(actor, paymentId) {
    await financeActor(actor);
    need(
      provider?.mode === "sandbox",
      "PROVIDER_UNAVAILABLE",
      "Sandbox reconciliation is not configured.",
      503,
    );
    const payment = await statement(
      "SELECT * FROM mp_payments WHERE id=?",
      paymentId,
    ).first();
    need(payment, "NOT_FOUND", "Payment not found.", 404);
    const intent = await provider.retrieveIntent(payment.provider_id);
    if (intent.status === "succeeded") {
      await ingest({
        id: "reconcile-success:" + intent.id,
        type: "payment_intent.succeeded",
        livemode: false,
        data: { object: intent },
      });
    }
    const charge = intent.latest_charge;
    if (charge && typeof charge === "object" && charge.amount_refunded > 0)
      await ingest({
        id: "reconcile-refund:" + charge.id + ":" + charge.amount_refunded,
        type: "charge.refunded",
        livemode: false,
        data: { object: { ...charge, payment_intent: payment.provider_id } },
      });
    const transaction = intent.latest_charge?.balance_transaction;
    if (transaction && typeof transaction === "object") {
      need(
        transaction.currency === "usd" &&
          transaction.amount === payment.amount_cents &&
          Number.isSafeInteger(transaction.fee) &&
          transaction.fee >= 0 &&
          transaction.fee <= transaction.amount,
        "PROVIDER_MISMATCH",
        "Provider processing fees do not reconcile.",
        502,
      );
      if (transaction.fee > 0)
        await db.batch([
          statement(
            "INSERT OR IGNORE INTO mp_ledger_entries VALUES(?,?,?,?,?,?,?,?)",
            crypto.randomUUID(),
            payment.booking_id,
            payment.id,
            "fee:" + transaction.id,
            "processing_fee_expense",
            transaction.fee,
            0,
            clock(),
          ),
          statement(
            "INSERT OR IGNORE INTO mp_ledger_entries VALUES(?,?,?,?,?,?,?,?)",
            crypto.randomUUID(),
            payment.booking_id,
            payment.id,
            "fee:" + transaction.id,
            "processor_clearing",
            0,
            transaction.fee,
            clock(),
          ),
        ]);
    }
    return {
      paymentId,
      status: (
        await statement(
          "SELECT status FROM mp_payments WHERE id=?",
          paymentId,
        ).first()
      ).status,
      providerStatus: intent.status,
    };
  }
  async function ingestDispute(event) {
    const object = event.data.object;
    const payment = await statement(
      "SELECT * FROM mp_payments WHERE provider_id=?",
      object.payment_intent,
    ).first();
    need(
      payment,
      "PAYMENT_NOT_RECORDED",
      "The disputed payment needs reconciliation.",
      503,
    );
    need(
      typeof object.id === "string" &&
        object.id.length <= 128 &&
        object.currency === "usd" &&
        Number.isSafeInteger(object.amount) &&
        object.amount > 0 &&
        object.amount <= payment.amount_cents &&
        typeof object.status === "string",
      "PROVIDER_MISMATCH",
      "The dispute does not match this payment.",
      400,
    );
    const now = clock(),
      marker = crypto.randomUUID();
    const guard =
      "EXISTS(SELECT 1 FROM mp_webhook_events WHERE id=? AND processing_id=?)";
    const commands = [
      statement(
        "INSERT OR IGNORE INTO mp_webhook_events(id,provider,type,processing_id,created_at) VALUES(?,'stripe',?,?,?)",
        event.id,
        event.type,
        marker,
        now,
      ),
      statement(
        "INSERT INTO mp_disputes(provider_id,payment_id,amount_cents,currency,status,updated_at) SELECT ?,?,?,'USD',?,? WHERE " +
          guard +
          " ON CONFLICT(provider_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at WHERE mp_disputes.status NOT IN ('won','lost','prevented','warning_closed')",
        object.id,
        payment.id,
        object.amount,
        object.status,
        now,
        event.id,
        marker,
      ),
    ];
    commands.push(
      statement(
        "UPDATE mp_payments SET status=CASE WHEN EXISTS(SELECT 1 FROM mp_disputes WHERE payment_id=? AND status NOT IN ('won','prevented','warning_closed')) THEN 'DISPUTED' ELSE 'CAPTURED' END,updated_at=? WHERE id=? AND status IN ('CAPTURED','DISPUTED') AND " +
          guard,
        payment.id,
        now,
        payment.id,
        event.id,
        marker,
      ),
    );
    for (const tx of object.balance_transactions || []) {
      need(
        typeof tx.id === "string" &&
          tx.currency === "usd" &&
          Number.isSafeInteger(tx.amount) &&
          Math.abs(tx.amount) <= 1000000 &&
          Number.isSafeInteger(tx.fee) &&
          tx.fee >= 0 &&
          tx.fee <= 1000000,
        "PROVIDER_MISMATCH",
        "Dispute balance transactions need reconciliation.",
        400,
      );
      const rows = [];
      if (tx.amount < 0) rows.push(["dispute_receivable", -tx.amount, 0]);
      if (tx.amount > 0) rows.push(["dispute_receivable", 0, tx.amount]);
      if (tx.fee > 0) rows.push(["processing_fee_expense", tx.fee, 0]);
      const net = tx.amount - tx.fee;
      if (net < 0) rows.push(["processor_clearing", 0, -net]);
      if (net > 0) rows.push(["processor_clearing", net, 0]);
      for (const [account, debit, credit] of rows)
        commands.push(
          statement(
            "INSERT OR IGNORE INTO mp_ledger_entries VALUES(?,?,?,?,?,?,?,?)",
            crypto.randomUUID(),
            payment.booking_id,
            payment.id,
            "dispute:" + object.id + ":" + tx.id,
            account,
            debit,
            credit,
            now,
          ),
        );
    }
    for (const [account, isDebit] of [
      ["dispute_loss_expense", true],
      ["dispute_receivable", false],
    ]) {
      commands.push(
        statement(
          "INSERT OR IGNORE INTO mp_ledger_entries(id,booking_id,payment_id,event_id,account,debit_cents,credit_cents,created_at) SELECT ?,?,?,?,?," +
            (isDebit ? "balance,0" : "0,balance") +
            ",? FROM (SELECT sum(debit_cents-credit_cents) balance FROM mp_ledger_entries WHERE payment_id=? AND account='dispute_receivable' AND event_id LIKE ?) " +
            "WHERE balance>0 AND EXISTS(SELECT 1 FROM mp_disputes WHERE provider_id=? AND status='lost')",
          crypto.randomUUID(),
          payment.booking_id,
          payment.id,
          "dispute-loss:" + object.id,
          account,
          now,
          payment.id,
          "dispute:" + object.id + ":%",
          object.id,
        ),
      );
    }
    commands.push(
      statement(
        "INSERT INTO mp_audit_events(id,actor_id,subject_id,action,details,created_at) SELECT ?,NULL,?,'provider-dispute',?,? WHERE " +
          guard,
        crypto.randomUUID(),
        payment.id,
        JSON.stringify({
          providerId: object.id,
          status: object.status,
          amountCents: object.amount,
        }),
        now,
        event.id,
        marker,
      ),
    );
    await db.batch(commands);
    return {
      received: true,
      disputeId: object.id,
      reconciliationRequired:
        object.status === "lost" || !object.balance_transactions?.length,
    };
  }
  async function refundTip(actor, bookingId) {
    await financeActor(actor);
    return dispatchTipRefund(bookingId);
  }
  async function dispatchTipRefund(bookingId) {
    need(
      provider?.mode === "sandbox",
      "PROVIDER_UNAVAILABLE",
      "Sandbox refunds are not configured.",
      503,
    );
    const tip = await statement(
      "SELECT t.*,p.id payment_id,COALESCE(r.refunded_cents,0) refunded_cents FROM mp_tips t JOIN mp_payments p ON p.booking_id=t.booking_id LEFT JOIN mp_tip_refund_totals r ON r.tip_id=t.id WHERE t.booking_id=? AND p.status='REFUNDED'",
      bookingId,
    ).first();
    need(
      tip && tip.status !== "PENDING",
      "INVALID_STATE",
      "A settled tip on a refunded session is required.",
    );
    if (tip.status === "REFUNDED")
      return { alreadySubmitted: true, status: "REFUNDED" };
    const now = clock();
    await statement(
      "INSERT OR IGNORE INTO mp_tip_refund_submissions(tip_id,amount_cents,previous_cents,created_at) VALUES(?,?,?,?)",
      tip.id,
      tip.amount_cents - tip.refunded_cents,
      tip.refunded_cents,
      now,
    ).run();
    const submission = await statement(
      "SELECT * FROM mp_tip_refund_submissions WHERE tip_id=?",
      tip.id,
    ).first();
    if (submission.provider_id)
      return {
        alreadySubmitted: true,
        awaitingProvider: true,
        providerId: submission.provider_id,
      };
    need(
      submission.previous_cents === tip.refunded_cents,
      "RECONCILIATION_REQUIRED",
      "An external tip refund changed the remaining principal after approval.",
    );
    await statement(
      "INSERT OR IGNORE INTO mp_financial_jobs(id,payment_id,kind,reference_id,status,available_at,created_at) VALUES(?,?,'TIP_REFUND',?,'PENDING',?,?)",
      crypto.randomUUID(),
      tip.payment_id,
      bookingId,
      now,
      now,
    ).run();
    const job = await statement(
      "SELECT * FROM mp_financial_jobs WHERE kind='TIP_REFUND' AND reference_id=?",
      bookingId,
    ).first();
    const lease = await statement(
      "UPDATE mp_financial_jobs SET status='PROCESSING',lease_until=?,attempts=attempts+1 WHERE id=? AND status<>'SUCCEEDED' AND attempts<8 AND lease_until<=? AND available_at<=?",
      now + 30000,
      job.id,
      now,
      now,
    ).run();
    need(
      lease.meta.changes === 1,
      "JOB_BUSY",
      "This tip refund is processing or waiting for retry.",
    );
    try {
      const response = await provider.refund(
        {
          paymentIntentId: tip.provider_id,
          amountCents: submission.amount_cents,
        },
        "hc-tip-refund-" + tip.id,
      );
      need(
        response.livemode === false &&
          response.amount === submission.amount_cents &&
          response.payment_intent === tip.provider_id &&
          typeof response.id === "string" &&
          /^re_[a-zA-Z0-9_]+$/.test(response.id),
        "PROVIDER_MISMATCH",
        "The provider returned a different tip reversal.",
        502,
      );
      await db.batch([
        statement(
          "UPDATE mp_financial_jobs SET status='SUCCEEDED',lease_until=0,last_error=NULL WHERE id=?",
          job.id,
        ),
        statement(
          "UPDATE mp_tip_refund_submissions SET provider_id=? WHERE tip_id=?",
          response.id,
          tip.id,
        ),
      ]);
      return {
        submitted: true,
        awaitingProvider: true,
        providerId: response.id,
        amountCents: submission.amount_cents,
      };
    } catch (error) {
      await statement(
        "UPDATE mp_financial_jobs SET status='FAILED',lease_until=0,available_at=?,last_error='Provider submission failed' WHERE id=?",
        now + Math.min(3600000, 1000 * 2 ** job.attempts),
        job.id,
      ).run();
      throw error;
    }
  }
  async function retryPending() {
    if (provider?.mode !== "sandbox") return { processed: 0 };
    const pending = (
      await statement(
        "SELECT reference_id,kind FROM mp_financial_jobs WHERE kind IN ('REFUND','TIP_REFUND') AND status IN ('PENDING','FAILED','PROCESSING') AND lease_until<=? AND available_at<=? AND attempts<8 LIMIT 20",
        clock(),
        clock(),
      ).all()
    ).results;
    let processed = 0;
    for (const row of pending) {
      try {
        if (row.kind === "TIP_REFUND")
          await dispatchTipRefund(row.reference_id);
        else await dispatchApprovedRefund(row.reference_id);
        processed++;
      } catch {
        /* Persisted retry metadata remains available to finance operations. */
      }
    }
    return { processed };
  }
  return {
    checkout,
    ingest,
    tip,
    refundTip,
    dispatchRefund,
    reviewRefund,
    reconcile,
    retryPending,
  };
}
