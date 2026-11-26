PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mp_demo_guest_issue_requests (
 booking_id TEXT NOT NULL REFERENCES mp_demo_guest_invitations(booking_id),
 request_digest TEXT NOT NULL,
 PRIMARY KEY(booking_id,request_digest)
);

-- Anonymous counters have no member identity. Their keys are derived server-side and are short-lived.
CREATE TABLE IF NOT EXISTS mp_demo_guest_claim_quota (
 bucket TEXT NOT NULL,
 window INTEGER NOT NULL,
 count INTEGER NOT NULL,
 PRIMARY KEY(bucket,window)
);

CREATE TABLE IF NOT EXISTS mp_demo_guest_report_triage (
 booking_id TEXT PRIMARY KEY REFERENCES mp_demo_guest_invitations(booking_id),
 assigned_to TEXT NOT NULL REFERENCES mp_users(id),
 assigned_at INTEGER NOT NULL,
 disposition TEXT CHECK(disposition IN ('reviewed','follow-up-required')),
 resolved_at INTEGER,
 CHECK((disposition IS NULL)=(resolved_at IS NULL))
);

CREATE INDEX IF NOT EXISTS mp_demo_guest_status_expiry
 ON mp_demo_guest_invitations(status,invite_expires_at);
CREATE INDEX IF NOT EXISTS mp_demo_guest_reported_at
 ON mp_demo_guest_invitations(guest_reported_at) WHERE guest_reported_at IS NOT NULL;

-- Terminal status is irreversible for a booking. Keep the safety report separate from access credentials.
CREATE TRIGGER IF NOT EXISTS mp_demo_guest_clear_terminal_access
AFTER UPDATE OF status ON mp_demo_guest_invitations
WHEN NEW.status IN ('HOST_DECLINED','CUSTOMER_DECLINED','REVOKED','GUEST_REMOVED','GUEST_LEFT','SESSION_ENDED')
BEGIN
 UPDATE mp_demo_guest_invitations
 SET guest_scope=NULL,guest_digest=NULL,guest_terms_version=NULL
 WHERE booking_id=NEW.booking_id;
 DELETE FROM mp_demo_guest_issue_requests WHERE booking_id=NEW.booking_id;
END;

CREATE TRIGGER IF NOT EXISTS mp_demo_guest_clear_expired_triage
AFTER UPDATE OF guest_reported_at ON mp_demo_guest_invitations
WHEN OLD.guest_reported_at IS NOT NULL AND NEW.guest_reported_at IS NULL
BEGIN
 DELETE FROM mp_demo_guest_report_triage WHERE booking_id=NEW.booking_id;
END;

UPDATE mp_demo_guest_invitations
 SET guest_scope=NULL,guest_digest=NULL,guest_terms_version=NULL
 WHERE status IN ('HOST_DECLINED','CUSTOMER_DECLINED','REVOKED','GUEST_REMOVED','GUEST_LEFT','SESSION_ENDED')
 AND (guest_scope IS NOT NULL OR guest_terms_version IS NOT NULL);
