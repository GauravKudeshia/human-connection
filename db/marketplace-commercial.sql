-- Additive, repeatable commercial controls; no live payment or payout activation.
CREATE TABLE IF NOT EXISTS mp_payment_refund_totals (
 payment_id TEXT PRIMARY KEY REFERENCES mp_payments(id),
 refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK(refunded_cents>=0), updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_refund_steps (
 event_id TEXT PRIMARY KEY REFERENCES mp_webhook_events(id),payment_id TEXT NOT NULL REFERENCES mp_payments(id),
 previous_cents INTEGER NOT NULL CHECK(previous_cents>=0),cumulative_cents INTEGER NOT NULL,
 created_at INTEGER NOT NULL,CHECK(cumulative_cents>previous_cents),UNIQUE(payment_id,cumulative_cents)
);
CREATE TABLE IF NOT EXISTS mp_refund_awards (
 id TEXT PRIMARY KEY,refund_id TEXT NOT NULL REFERENCES mp_refunds(id),payment_id TEXT NOT NULL REFERENCES mp_payments(id),
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0),cumulative_target INTEGER NOT NULL CHECK(cumulative_target>=amount_cents),
 reviewer_id TEXT NOT NULL REFERENCES mp_users(id),reason TEXT NOT NULL,request_key TEXT NOT NULL,
 fingerprint TEXT NOT NULL,provider_id TEXT UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('APPROVED','SUBMITTED','CONFIRMED')),
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(reviewer_id,request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS mp_one_unsettled_refund_award ON mp_refund_awards(payment_id) WHERE status IN ('APPROVED','SUBMITTED');
CREATE TABLE IF NOT EXISTS mp_payout_batches (
 id TEXT PRIMARY KEY,host_id TEXT NOT NULL REFERENCES mp_users(id),destination_reference TEXT NOT NULL,
 currency TEXT NOT NULL CHECK(currency='USD'),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 status TEXT NOT NULL CHECK(status IN ('REQUESTED','APPROVED','PROCESSING','SUBMITTED','RECONCILED','FAILED','REVERSED','CANCELLED')),
 requested_by TEXT NOT NULL REFERENCES mp_users(id),approved_by TEXT REFERENCES mp_users(id),
 provider_id TEXT UNIQUE,request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,
 available_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 UNIQUE(requested_by,request_key),CHECK(approved_by IS NULL OR requested_by<>approved_by)
);
CREATE TABLE IF NOT EXISTS mp_payout_items (
 batch_id TEXT NOT NULL REFERENCES mp_payout_batches(id),payment_id TEXT NOT NULL REFERENCES mp_payments(id),
 account TEXT NOT NULL CHECK(account IN ('host_base_payable','host_tip_payable')),
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0),PRIMARY KEY(batch_id,payment_id,account)
);
CREATE TABLE IF NOT EXISTS mp_payout_holds (
 payment_id TEXT PRIMARY KEY REFERENCES mp_payments(id),batch_id TEXT NOT NULL REFERENCES mp_payout_batches(id)
);
CREATE TRIGGER IF NOT EXISTS mp_refund_steps_no_update BEFORE UPDATE ON mp_refund_steps BEGIN SELECT RAISE(ABORT,'Refund steps are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mp_refund_steps_no_delete BEFORE DELETE ON mp_refund_steps BEGIN SELECT RAISE(ABORT,'Refund steps are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mp_award_terms_immutable BEFORE UPDATE OF amount_cents,cumulative_target,payment_id,refund_id,reviewer_id,reason,request_key,fingerprint ON mp_refund_awards BEGIN SELECT RAISE(ABORT,'Refund award terms are immutable'); END;

INSERT OR IGNORE INTO mp_payment_refund_totals(payment_id,refunded_cents,updated_at)
 SELECT id,CASE WHEN status='REFUNDED' THEN amount_cents ELSE 0 END,updated_at FROM mp_payments;

CREATE TABLE IF NOT EXISTS mp_refund_decisions (
 reviewer_id TEXT NOT NULL REFERENCES mp_users(id),request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,
 response TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(reviewer_id,request_key)
);
CREATE TRIGGER IF NOT EXISTS mp_refund_decisions_no_update BEFORE UPDATE ON mp_refund_decisions BEGIN SELECT RAISE(ABORT,'Refund decisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mp_refund_decisions_no_delete BEFORE DELETE ON mp_refund_decisions BEGIN SELECT RAISE(ABORT,'Refund decisions are append-only'); END;
CREATE TABLE IF NOT EXISTS mp_payout_reversal_totals (
 batch_id TEXT PRIMARY KEY REFERENCES mp_payout_batches(id),reversed_cents INTEGER NOT NULL DEFAULT 0 CHECK(reversed_cents>=0),updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_payout_reversal_steps (
 id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES mp_payout_batches(id),
 previous_cents INTEGER NOT NULL CHECK(previous_cents>=0),cumulative_cents INTEGER NOT NULL,
 created_at INTEGER NOT NULL,CHECK(cumulative_cents>previous_cents),UNIQUE(batch_id,cumulative_cents)
);
CREATE TRIGGER IF NOT EXISTS mp_payout_reversal_steps_no_update BEFORE UPDATE ON mp_payout_reversal_steps BEGIN SELECT RAISE(ABORT,'Transfer reversal steps are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mp_payout_reversal_steps_no_delete BEFORE DELETE ON mp_payout_reversal_steps BEGIN SELECT RAISE(ABORT,'Transfer reversal steps are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mp_payout_items_no_update BEFORE UPDATE ON mp_payout_items BEGIN SELECT RAISE(ABORT,'Transfer allocations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS mp_payout_items_no_delete BEFORE DELETE ON mp_payout_items BEGIN SELECT RAISE(ABORT,'Transfer allocations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS mp_payout_terms_immutable BEFORE UPDATE OF host_id,destination_reference,currency,amount_cents,requested_by,request_key,fingerprint ON mp_payout_batches BEGIN SELECT RAISE(ABORT,'Transfer terms are immutable'); END;
CREATE TABLE IF NOT EXISTS mp_tip_refund_totals (
 tip_id TEXT PRIMARY KEY REFERENCES mp_tips(id),refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK(refunded_cents>=0),updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_tip_refund_steps (
 event_id TEXT PRIMARY KEY REFERENCES mp_webhook_events(id),tip_id TEXT NOT NULL REFERENCES mp_tips(id),
 previous_cents INTEGER NOT NULL CHECK(previous_cents>=0),cumulative_cents INTEGER NOT NULL,
 created_at INTEGER NOT NULL,CHECK(cumulative_cents>previous_cents),UNIQUE(tip_id,cumulative_cents)
);
CREATE TRIGGER IF NOT EXISTS mp_tip_refund_steps_no_update BEFORE UPDATE ON mp_tip_refund_steps BEGIN SELECT RAISE(ABORT,'Tip refund steps are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mp_tip_refund_steps_no_delete BEFORE DELETE ON mp_tip_refund_steps BEGIN SELECT RAISE(ABORT,'Tip refund steps are append-only'); END;
INSERT OR IGNORE INTO mp_tip_refund_totals(tip_id,refunded_cents,updated_at)
 SELECT id,CASE WHEN status='REFUNDED' THEN amount_cents ELSE 0 END,updated_at FROM mp_tips;
CREATE TABLE IF NOT EXISTS mp_tip_refund_submissions (
 tip_id TEXT PRIMARY KEY REFERENCES mp_tips(id),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 previous_cents INTEGER NOT NULL CHECK(previous_cents>=0),provider_id TEXT UNIQUE,created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS mp_tip_refund_terms_immutable BEFORE UPDATE OF amount_cents,previous_cents,tip_id ON mp_tip_refund_submissions BEGIN SELECT RAISE(ABORT,'Tip refund terms are immutable'); END;
