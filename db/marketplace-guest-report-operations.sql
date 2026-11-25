PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mp_demo_guest_report_access (
 booking_id TEXT PRIMARY KEY REFERENCES mp_demo_guest_invitations(booking_id),
 guest_scope TEXT NOT NULL UNIQUE,
 guest_digest TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mp_demo_guest_report_access_expiry ON mp_demo_guest_report_access(expires_at);

CREATE TABLE IF NOT EXISTS mp_demo_guest_report_controls (
 booking_id TEXT PRIMARY KEY REFERENCES mp_demo_guest_invitations(booking_id),
 escalated_at INTEGER,
 retention_ms INTEGER CHECK(retention_ms>=0)
);

-- The grant authorizes safety intake only. It survives the room binding's terminal cleanup.
CREATE TRIGGER IF NOT EXISTS mp_demo_guest_reporting_admission
AFTER UPDATE OF status ON mp_demo_guest_invitations
WHEN OLD.status='GUEST_WAITING' AND NEW.status='GUEST_ADMITTED'
BEGIN
 INSERT OR IGNORE INTO mp_demo_guest_report_access(booking_id,guest_scope,guest_digest,expires_at)
 SELECT NEW.booking_id,NEW.guest_scope,NEW.guest_digest,expires_at+3600000
 FROM mp_demo_guest_live_bookings WHERE id=NEW.booking_id;
END;

CREATE TRIGGER IF NOT EXISTS mp_demo_guest_clear_report_controls
AFTER UPDATE OF guest_reported_at ON mp_demo_guest_invitations
WHEN OLD.guest_reported_at IS NOT NULL AND NEW.guest_reported_at IS NULL
BEGIN
 DELETE FROM mp_demo_guest_report_controls WHERE booking_id=NEW.booking_id;
END;

-- Follow-up decisions from the earlier queue require active attention.
INSERT OR IGNORE INTO mp_demo_guest_report_controls(booking_id,escalated_at)
 SELECT booking_id,resolved_at FROM mp_demo_guest_report_triage WHERE disposition='follow-up-required';
UPDATE mp_demo_guest_report_triage SET disposition=NULL,resolved_at=NULL WHERE disposition='follow-up-required';
