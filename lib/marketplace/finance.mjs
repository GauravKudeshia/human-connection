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
        const delivered = await statement(
          "SELECT 1 AS found FROM mp_ledger_entries WHERE event_id=?",
          "delivery:" + payment.id,
        ).first();
        if (delivered) {
          const original = (
            await statement(
              "SELECT account,credit_cents FROM mp_ledger_entries WHERE event_id=? AND credit_cents>0",
              "delivery:" + payment.id,
            ).all()
          ).results;
          for (const line of original)
            journal("refund", line.account, line.credit_cents, 0);
        } else journal("refund", "service_liability", payment.amount_cents, 0);
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
    need(
      isRefund
        ? object.refunded === true &&
            object.amount_refunded === tipRecord.amount_cents
        : object.amount_received === tipRecord.amount_cents,
      "PROVIDER_MISMATCH",
      "Only a complete tip capture or reversal is accepted.",
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
      ledger("tip-refund", "host_tip_payable", tipRecord.amount_cents, 0);
      ledger("tip-refund", "processor_clearing", 0, tipRecord.amount_cents);
    }
    commands.push(
      statement(
        "UPDATE mp_tips SET status=?,updated_at=? WHERE id=? AND status<>'REFUNDED' AND " +
          guard,
        isRefund ? "REFUNDED" : "CAPTURED",
        now,
        tipRecord.id,
        event.id,
        marker,
      ),
    );
    await db.batch(commands);
    return { received: true, tipId: tipRecord.id };
  }
  async function dispatchRefund(actor, refundId) {
    await financeActor(actor);
    return dispatchApprovedRefund(refundId);
  }
  async function dispatchApprovedRefund(refundId) {
    need(
      provider?.mode === "sandbox",
      "PROVIDER_UNAVAILABLE",
      "Sandbox refund processing is not configured.",
      503,
    );
    const r = await statement(
      "SELECT r.*,p.provider_id,p.amount_cents,p.status payment_status FROM mp_refunds r JOIN mp_payments p ON p.id=r.payment_id WHERE r.id=?",
      refundId,
    ).first();
    need(
      r && ["APPROVED", "REFUNDED"].includes(r.status),
      "INVALID_STATE",
      "Approve the refund before provider submission.",
    );
    if (r.status === "REFUNDED")
      return { alreadySubmitted: true, status: "REFUNDED" };
    const now = clock();
    await statement(
      "INSERT OR IGNORE INTO mp_financial_jobs(id,payment_id,kind,reference_id,status,available_at,created_at) VALUES(?,?,'REFUND',?,'PENDING',?,?)",
      crypto.randomUUID(),
      r.payment_id,
      refundId,
      now,
      now,
    ).run();
    const job = await statement(
      "SELECT * FROM mp_financial_jobs WHERE kind='REFUND' AND reference_id=?",
      refundId,
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
        { paymentIntentId: r.provider_id, amountCents: r.amount_cents },
        "hc-refund-" + refundId,
      );
      need(
        response.livemode === false &&
          response.amount === r.amount_cents &&
          response.payment_intent === r.provider_id,
        "PROVIDER_MISMATCH",
        "The provider returned a different refund.",
        502,
      );
      await statement(
        "UPDATE mp_financial_jobs SET status='SUCCEEDED',lease_until=0,last_error=NULL WHERE id=?",
        job.id,
      ).run();
      return {
        submitted: true,
        awaitingProvider: true,
        providerId: response.id,
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
    need(
      provider?.mode === "sandbox",
      "PROVIDER_UNAVAILABLE",
      "Sandbox refunds are not configured.",
      503,
    );
    const tip = await statement(
      "SELECT t.* FROM mp_tips t JOIN mp_payments p ON p.booking_id=t.booking_id WHERE t.booking_id=? AND p.status='REFUNDED'",
      bookingId,
    ).first();
    need(
      tip && tip.status !== "PENDING",
      "INVALID_STATE",
      "A settled tip on a refunded session is required.",
    );
    if (tip.status === "REFUNDED")
      return { alreadySubmitted: true, status: "REFUNDED" };
    const response = await provider.refund(
      { paymentIntentId: tip.provider_id, amountCents: tip.amount_cents },
      "hc-tip-refund-" + tip.id,
    );
    need(
      response.livemode === false &&
        response.amount === tip.amount_cents &&
        response.payment_intent === tip.provider_id,
      "PROVIDER_MISMATCH",
      "The provider returned a different tip reversal.",
      502,
    );
    return { submitted: true, awaitingProvider: true, providerId: response.id };
  }
  async function retryPending() {
    if (provider?.mode !== "sandbox") return { processed: 0 };
    const pending = (
      await statement(
        "SELECT reference_id FROM mp_financial_jobs WHERE kind='REFUND' AND status IN ('PENDING','FAILED','PROCESSING') AND lease_until<=? AND available_at<=? AND attempts<8 LIMIT 20",
        clock(),
        clock(),
      ).all()
    ).results;
    let processed = 0;
    for (const row of pending) {
      try {
        await dispatchApprovedRefund(row.reference_id);
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
    reconcile,
    retryPending,
  };
}
