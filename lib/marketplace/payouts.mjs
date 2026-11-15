import { requireCondition as need } from "./errors.mjs";
import { fingerprint } from "../fingerprint.mjs";

// This sends TEST connected-account transfers, never bank payouts. Real payouts
// stay unavailable regardless of configuration. No merchant model is implied.
export function createPayoutService(
  db,
  {
    provider,
    authorize,
    allowTestTransfers = false,
    clock = Date.now,
    settlementDelayMs = 7 * 86400000,
  } = {},
) {
  const sql = (query, ...args) => db.prepare(query).bind(...args);
  need(
    Number.isSafeInteger(settlementDelayMs) &&
      settlementDelayMs >= 0 &&
      settlementDelayMs <= 30 * 86400000,
    "CONFIGURATION",
    "Choose a valid sandbox settlement delay.",
    503,
  );
  async function finance(actor) {
    need(
      typeof authorize === "function",
      "FORBIDDEN",
      "A trusted finance authorization service is required.",
      403,
    );
    await authorize(actor, ["finance", "admin"], true);
    const user = await sql(
      "SELECT u.status FROM mp_users u JOIN mp_user_roles r ON r.user_id=u.id WHERE u.id=? AND r.role IN ('finance','admin')",
      actor?.id || "",
    ).first();
    need(
      user?.status === "ACTIVE" && actor.stepUp === true,
      "FORBIDDEN",
      "Recent multi-factor finance access is required.",
      403,
    );
  }
  function enabled() {
    need(
      allowTestTransfers === true &&
        provider?.mode === "sandbox" &&
        provider.createTransfer &&
        provider.retrieveTransfer,
      "PAYOUTS_DISABLED",
      "Sandbox connected-account transfers are disabled. Real payouts are not available.",
      503,
    );
  }
  async function hostReference(hostId) {
    const host = await sql(
      "SELECT e.payout_reference FROM mp_users u JOIN mp_host_profiles h ON h.user_id=u.id JOIN mp_host_verifications v ON v.user_id=u.id JOIN mp_host_verification_evidence e ON e.host_id=u.id WHERE u.id=? AND u.status='ACTIVE' AND h.status='APPROVED' AND v.status='VERIFIED' AND v.payout_status='ELIGIBLE' AND v.adult_verified=1 AND v.jurisdiction='US'",
      hostId,
    ).first();
    need(
      host && /^acct_[a-zA-Z0-9]+$/.test(host.payout_reference),
      "HOST_INELIGIBLE",
      "A verified approved U.S. host with a reviewed test account is required.",
    );
    return host.payout_reference;
  }
  async function balances(hostId, batchId = "") {
    const debt = await sql(
      "SELECT 1 FROM mp_ledger_entries l JOIN mp_bookings b ON b.id=l.booking_id WHERE b.host_id=? AND l.account IN ('host_base_payable','host_tip_payable') GROUP BY l.payment_id,l.account HAVING SUM(l.credit_cents-l.debit_cents)<0 LIMIT 1",
      hostId,
    ).first();
    need(
      !debt,
      "EARNINGS_RECONCILIATION_REQUIRED",
      "A prior refund or reversal has created a host liability requiring finance reconciliation.",
    );
    return (
      await sql(
        "SELECT l.payment_id,l.account,SUM(l.credit_cents-l.debit_cents) amount_cents FROM mp_ledger_entries l JOIN mp_payments p ON p.id=l.payment_id JOIN mp_bookings b ON b.id=l.booking_id LEFT JOIN mp_payout_holds h ON h.payment_id=p.id WHERE b.host_id=? AND b.status='COMPLETED' AND p.status='CAPTURED' AND l.account IN ('host_base_payable','host_tip_payable') AND (h.payment_id IS NULL OR h.batch_id=?) AND NOT EXISTS(SELECT 1 FROM mp_refunds r WHERE r.payment_id=p.id AND r.status IN ('OPEN','APPROVED')) AND NOT EXISTS(SELECT 1 FROM mp_disputes d WHERE d.payment_id=p.id AND d.status NOT IN ('won','prevented','warning_closed')) GROUP BY l.payment_id,l.account HAVING SUM(l.credit_cents-l.debit_cents)>0 AND MAX(l.created_at)<=?",
        hostId,
        batchId,
        clock() - settlementDelayMs,
      ).all()
    ).results;
  }
  async function request(actor, { hostId, reason }, key) {
    await finance(actor);
    enabled();
    need(
      typeof hostId === "string" &&
        typeof reason === "string" &&
        reason.trim().length > 0 &&
        reason.length <= 1000 &&
        typeof key === "string" &&
        key.length > 0 &&
        key.length <= 128,
      "VALIDATION",
      "Choose a host, explanation and request key.",
      400,
    );
    const digest = fingerprint(
      JSON.stringify({ hostId, reason: reason.trim() }),
    );
    const prior = await sql(
      "SELECT * FROM mp_payout_batches WHERE requested_by=? AND request_key=?",
      actor.id,
      key,
    ).first();
    if (prior) {
      need(
        prior.fingerprint === digest,
        "IDEMPOTENCY_CONFLICT",
        "This request key has different transfer details.",
      );
      return summary(prior);
    }
    const destination = await hostReference(hostId),
      items = await balances(hostId);
    const amount = items.reduce((sum, line) => sum + line.amount_cents, 0);
    need(
      Number.isSafeInteger(amount) && amount > 0 && amount <= 99999999,
      "NO_SETTLED_EARNINGS",
      "There are no unreserved settled earnings to transfer.",
    );
    const id = crypto.randomUUID(),
      now = clock();
    const commands = [
      sql(
        "INSERT INTO mp_payout_batches(id,host_id,destination_reference,currency,amount_cents,status,requested_by,request_key,fingerprint,available_at,created_at,updated_at) VALUES(?,?,?,'USD',?,'REQUESTED',?,?,?,?,?,?)",
        id,
        hostId,
        destination,
        amount,
        actor.id,
        key,
        digest,
        now,
        now,
        now,
      ),
    ];
    for (const paymentId of new Set(items.map((x) => x.payment_id)))
      commands.push(
        sql(
          "INSERT INTO mp_payout_holds(payment_id,batch_id) VALUES(?,?)",
          paymentId,
          id,
        ),
      );
    for (const item of items)
      commands.push(
        sql(
          "INSERT INTO mp_payout_items(batch_id,payment_id,account,amount_cents) VALUES(?,?,?,?)",
          id,
          item.payment_id,
          item.account,
          item.amount_cents,
        ),
      );
    commands.push(
      sql(
        "INSERT INTO mp_audit_events(id,actor_id,subject_id,action,details,created_at) VALUES(?,?,?,'sandbox-transfer-requested',?,?)",
        crypto.randomUUID(),
        actor.id,
        id,
        JSON.stringify({ reason: reason.trim(), amountCents: amount }),
        now,
      ),
    );
    try {
      await db.batch(commands);
    } catch {
      need(
        false,
        "TRANSFER_CONFLICT",
        "The earnings were reserved concurrently. Refresh before retrying.",
      );
    }
    return summary(
      await sql("SELECT * FROM mp_payout_batches WHERE id=?", id).first(),
    );
  }
  function summary(batch) {
    return {
      id: batch.id,
      hostId: batch.host_id,
      amountCents: batch.amount_cents,
      currency: "USD",
      status: batch.status,
      mode: "sandbox",
      kind: "connected-account-transfer",
      bankPayout: false,
      providerId: batch.provider_id || null,
    };
  }
  async function assertFunds(batch) {
    need(
      (await hostReference(batch.host_id)) === batch.destination_reference,
      "HOST_INELIGIBLE",
      "The reviewed destination changed.",
    );
    const current = await balances(batch.host_id, batch.id);
    const items = (
      await sql(
        "SELECT * FROM mp_payout_items WHERE batch_id=?",
        batch.id,
      ).all()
    ).results;
    need(
      items.length > 0 &&
        items.every((item) =>
          current.some(
            (line) =>
              line.payment_id === item.payment_id &&
              line.account === item.account &&
              line.amount_cents >= item.amount_cents,
          ),
        ),
      "EARNINGS_CHANGED",
      "A refund, dispute, settlement or account change requires a new transfer review.",
    );
    return items;
  }
  async function approve(actor, batchId) {
    await finance(actor);
    enabled();
    const batch = await sql(
      "SELECT * FROM mp_payout_batches WHERE id=?",
      batchId,
    ).first();
    need(batch, "NOT_FOUND", "Transfer not found.", 404);
    need(
      batch.requested_by !== actor.id,
      "SECOND_REVIEWER_REQUIRED",
      "A different finance reviewer must approve the transfer.",
      403,
    );
    if (batch.status === "APPROVED" && batch.approved_by === actor.id)
      return summary(batch);
    need(
      batch.status === "REQUESTED",
      "INVALID_STATE",
      "This transfer is no longer awaiting approval.",
    );
    await assertFunds(batch);
    await db.batch([
      sql(
        "UPDATE mp_payout_batches SET status='APPROVED',approved_by=?,updated_at=? WHERE id=? AND status='REQUESTED'",
        actor.id,
        clock(),
        batchId,
      ),
      sql(
        "INSERT INTO mp_audit_events(id,actor_id,subject_id,action,details,created_at) SELECT ?,?,?,'sandbox-transfer-approved','{}',? WHERE EXISTS(SELECT 1 FROM mp_payout_batches WHERE id=? AND approved_by=?)",
        crypto.randomUUID(),
        actor.id,
        batchId,
        clock(),
        batchId,
        actor.id,
      ),
    ]);
    const saved = await sql(
      "SELECT * FROM mp_payout_batches WHERE id=?",
      batchId,
    ).first();
    need(
      saved.approved_by === actor.id,
      "INVALID_STATE",
      "Another reviewer changed this transfer.",
    );
    return summary(saved);
  }
  async function dispatch(actor, batchId) {
    await finance(actor);
    enabled();
    const batch = await sql(
      "SELECT * FROM mp_payout_batches WHERE id=?",
      batchId,
    ).first();
    need(batch, "NOT_FOUND", "Transfer not found.", 404);
    if (["SUBMITTED", "RECONCILED", "REVERSED"].includes(batch.status))
      return summary(batch);
    need(
      batch.approved_by &&
        ["APPROVED", "FAILED", "PROCESSING"].includes(batch.status),
      "INVALID_STATE",
      "A second reviewer must approve this transfer.",
    );
    await assertFunds(batch);
    const now = clock();
    const leased = await sql(
      "UPDATE mp_payout_batches SET status='PROCESSING',attempts=attempts+1,lease_until=?,updated_at=? WHERE id=? AND status IN ('APPROVED','FAILED','PROCESSING') AND lease_until<=? AND attempts<8 AND available_at<=?",
      now + 30000,
      now,
      batchId,
      now,
      now,
    ).run();
    need(
      leased.meta.changes === 1,
      "JOB_BUSY",
      "This transfer is processing or waiting for retry.",
    );
    try {
      const transfer = await provider.createTransfer(
        {
          batchId,
          destination: batch.destination_reference,
          amountCents: batch.amount_cents,
        },
        "hc-test-transfer-" + batchId,
      );
      validateTransfer(batch, transfer);
      await sql(
        "UPDATE mp_payout_batches SET status='SUBMITTED',provider_id=?,lease_until=0,updated_at=? WHERE id=?",
        transfer.id,
        clock(),
        batchId,
      ).run();
      return summary(
        await sql(
          "SELECT * FROM mp_payout_batches WHERE id=?",
          batchId,
        ).first(),
      );
    } catch (error) {
      await sql(
        "UPDATE mp_payout_batches SET status='FAILED',lease_until=0,available_at=?,updated_at=? WHERE id=? AND status='PROCESSING'",
        now + Math.min(3600000, 1000 * 2 ** batch.attempts),
        clock(),
        batchId,
      ).run();
      throw error;
    }
  }
  function validateTransfer(batch, transfer) {
    need(
      transfer?.livemode === false &&
        typeof transfer.id === "string" &&
        /^tr_[a-zA-Z0-9]+$/.test(transfer.id) &&
        transfer.amount === batch.amount_cents &&
        transfer.currency === "usd" &&
        transfer.destination === batch.destination_reference &&
        transfer.metadata?.batch_id === batch.id,
      "PROVIDER_MISMATCH",
      "The sandbox transfer does not match its approved allocation.",
      502,
    );
  }
  async function reconcile(actor, batchId) {
    await finance(actor);
    enabled();
    const batch = await sql(
      "SELECT * FROM mp_payout_batches WHERE id=?",
      batchId,
    ).first();
    need(
      batch?.provider_id,
      "INVALID_STATE",
      "Submit the sandbox transfer before reconciliation.",
    );
    const transfer = await provider.retrieveTransfer(batch.provider_id);
    validateTransfer(batch, transfer);
    need(
      Number.isSafeInteger(transfer.amount_reversed) &&
        transfer.amount_reversed >= 0 &&
        transfer.amount_reversed <= batch.amount_cents,
      "PROVIDER_MISMATCH",
      "The transfer reversal exceeds its approved principal.",
      502,
    );
    const reversed = transfer.amount_reversed,
      stepId = crypto.randomUUID(),
      now = clock();
    const items = (
      await sql(
        "SELECT * FROM mp_payout_items WHERE batch_id=? ORDER BY payment_id,account",
        batch.id,
      ).all()
    ).results;
    const commands = [
      sql(
        "INSERT OR IGNORE INTO mp_payout_reversal_totals(batch_id,reversed_cents,updated_at) VALUES(?,0,?)",
        batch.id,
        now,
      ),
      sql(
        "INSERT OR IGNORE INTO mp_payout_reversal_steps(id,batch_id,previous_cents,cumulative_cents,created_at) SELECT ?,batch_id,reversed_cents,?,? FROM mp_payout_reversal_totals WHERE batch_id=? AND reversed_cents<?",
        stepId,
        reversed,
        now,
        batch.id,
        reversed,
      ),
    ];
    let prefix = 0;
    // Immutable original allocation order defines a deterministic waterfall for
    // returned funds. Each additional cent can only restore a payable once.
    for (const item of items) {
      const payment = await sql(
        "SELECT booking_id FROM mp_payments WHERE id=?",
        item.payment_id,
      ).first();
      const event = "transfer:" + batch.id + ":" + item.payment_id;
      commands.push(
        sql(
          "INSERT OR IGNORE INTO mp_ledger_entries VALUES(?,?,?,?,?,?,?,?)",
          crypto.randomUUID(),
          payment.booking_id,
          item.payment_id,
          event,
          item.account,
          item.amount_cents,
          0,
          now,
        ),
      );
      const delta =
        "MIN(?,MAX(0,cumulative_cents-?))-MIN(?,MAX(0,previous_cents-?))";
      const args = [item.amount_cents, prefix, item.amount_cents, prefix];
      const reversalEvent =
        "transfer-reversal:" +
        batch.id +
        ":" +
        reversed +
        ":" +
        item.payment_id +
        ":" +
        item.account;
      for (const account of [item.account, "processor_clearing"])
        commands.push(
          sql(
            "INSERT OR IGNORE INTO mp_ledger_entries(id,booking_id,payment_id,event_id,account,debit_cents,credit_cents,created_at) SELECT ?,?,?,?,?, " +
              (account === "processor_clearing" ? "n,0" : "0,n") +
              ",? FROM (SELECT " +
              delta +
              " n FROM mp_payout_reversal_steps WHERE id=?) WHERE n>0",
            crypto.randomUUID(),
            payment.booking_id,
            item.payment_id,
            reversalEvent,
            account,
            now,
            ...args,
            stepId,
          ),
        );
      prefix += item.amount_cents;
    }
    for (const paymentId of new Set(items.map((x) => x.payment_id))) {
      const payment = await sql(
        "SELECT booking_id FROM mp_payments WHERE id=?",
        paymentId,
      ).first();
      const total = items
        .filter((x) => x.payment_id === paymentId)
        .reduce((sum, x) => sum + x.amount_cents, 0);
      commands.push(
        sql(
          "INSERT OR IGNORE INTO mp_ledger_entries VALUES(?,?,?,?,?,?,?,?)",
          crypto.randomUUID(),
          payment.booking_id,
          paymentId,
          "transfer:" + batch.id + ":" + paymentId,
          "processor_clearing",
          0,
          total,
          now,
        ),
      );
    }
    commands.push(
      sql(
        "UPDATE mp_payout_reversal_totals SET reversed_cents=?,updated_at=? WHERE batch_id=? AND reversed_cents<? AND EXISTS(SELECT 1 FROM mp_payout_reversal_steps WHERE id=?)",
        reversed,
        now,
        batch.id,
        reversed,
        stepId,
      ),
      sql(
        "UPDATE mp_payout_batches SET status=CASE WHEN (SELECT reversed_cents FROM mp_payout_reversal_totals WHERE batch_id=?)=amount_cents THEN 'REVERSED' ELSE 'RECONCILED' END,updated_at=? WHERE id=?",
        batch.id,
        now,
        batch.id,
      ),
      sql("DELETE FROM mp_payout_holds WHERE batch_id=?", batch.id),
      sql(
        "INSERT INTO mp_audit_events(id,actor_id,subject_id,action,details,created_at) VALUES(?,?,?,'sandbox-transfer-reconciled',?,?)",
        crypto.randomUUID(),
        actor.id,
        batch.id,
        JSON.stringify({ providerId: transfer.id, reversedCents: reversed }),
        now,
      ),
    );
    await db.batch(commands);
    return summary(
      await sql("SELECT * FROM mp_payout_batches WHERE id=?", batch.id).first(),
    );
  }
  async function cancel(actor, batchId) {
    await finance(actor);
    const batch = await sql(
      "SELECT * FROM mp_payout_batches WHERE id=?",
      batchId,
    ).first();
    need(batch, "NOT_FOUND", "Transfer not found.", 404);
    if (batch.status === "CANCELLED") return summary(batch);
    need(
      ["REQUESTED", "APPROVED"].includes(batch.status) && batch.attempts === 0,
      "INVALID_STATE",
      "A submitted or ambiguous transfer must be reconciled before releasing its funds.",
    );
    await db.batch([
      sql(
        "UPDATE mp_payout_batches SET status='CANCELLED',updated_at=? WHERE id=? AND status IN ('REQUESTED','APPROVED') AND attempts=0",
        clock(),
        batchId,
      ),
      sql(
        "DELETE FROM mp_payout_holds WHERE batch_id=? AND EXISTS(SELECT 1 FROM mp_payout_batches WHERE id=? AND status='CANCELLED')",
        batchId,
        batchId,
      ),
      sql(
        "INSERT INTO mp_audit_events(id,actor_id,subject_id,action,details,created_at) SELECT ?,?,?,'sandbox-transfer-cancelled','{}',? WHERE EXISTS(SELECT 1 FROM mp_payout_batches WHERE id=? AND status='CANCELLED')",
        crypto.randomUUID(),
        actor.id,
        batchId,
        clock(),
        batchId,
      ),
    ]);
    const saved = await sql(
      "SELECT * FROM mp_payout_batches WHERE id=?",
      batchId,
    ).first();
    need(
      saved.status === "CANCELLED",
      "INVALID_STATE",
      "Transfer submission started before cancellation.",
    );
    return summary(saved);
  }
  async function read(actor) {
    await finance(actor);
    return {
      enabled: allowTestTransfers === true && provider?.mode === "sandbox",
      bankPayoutsEnabled: false,
      settlementDelayMs,
      batches: (
        await sql(
          "SELECT * FROM mp_payout_batches ORDER BY created_at DESC LIMIT 100",
        ).all()
      ).results.map(summary),
    };
  }
  return { request, approve, dispatch, reconcile, cancel, read };
}
