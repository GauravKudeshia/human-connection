PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mp_demo_guest_invitations (
 booking_id TEXT PRIMARY KEY REFERENCES mp_bookings(id),
 status TEXT NOT NULL CHECK(status IN (
   'HOST_PENDING','HOST_APPROVED','HOST_DECLINED','ISSUED','GUEST_WAITING',
   'GUEST_ADMITTED','CUSTOMER_DECLINED','REVOKED','GUEST_REMOVED','GUEST_LEFT',
   'SESSION_ENDED'
 )),
 invite_digest TEXT UNIQUE,
 invite_expires_at INTEGER,
 guest_scope TEXT UNIQUE,
 guest_digest TEXT UNIQUE,
 guest_terms_version TEXT,
 guest_report_category TEXT CHECK(guest_report_category IN ('conduct','privacy','safety')),
 guest_reported_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK((status='ISSUED')=(invite_digest IS NOT NULL)),
 CHECK((guest_scope IS NULL)=(guest_digest IS NULL))
);

CREATE VIEW IF NOT EXISTS mp_demo_guest_live_bookings AS
SELECT b.id,b.customer_id,b.host_id,b.expires_at
 FROM mp_bookings b
 JOIN mp_payments p ON p.booking_id=b.id AND p.status='CAPTURED'
   AND p.amount_cents=b.amount_cents AND p.amount_cents>0 AND p.currency=b.currency
 JOIN mp_users customer ON customer.id=b.customer_id AND customer.status='ACTIVE'
 JOIN mp_users host ON host.id=b.host_id AND host.status='ACTIVE'
 JOIN mp_host_profiles h ON h.user_id=host.id AND h.status='APPROVED'
 JOIN mp_host_verifications v ON v.user_id=host.id AND v.status='VERIFIED'
   AND v.adult_verified=1 AND v.jurisdiction='US' AND v.payout_status='ELIGIBLE'
 WHERE b.status='LIVE'
   AND EXISTS(SELECT 1 FROM mp_user_roles WHERE user_id=host.id AND role='host')
   AND NOT EXISTS(SELECT 1 FROM mp_blocks
     WHERE (owner_id=b.customer_id AND blocked_id=b.host_id)
        OR (owner_id=b.host_id AND blocked_id=b.customer_id));

CREATE TRIGGER IF NOT EXISTS mp_demo_guest_close_on_end
AFTER UPDATE OF status ON mp_bookings
WHEN OLD.status='LIVE' AND NEW.status<>'LIVE'
BEGIN
 UPDATE mp_demo_guest_invitations
 SET status='SESSION_ENDED',invite_digest=NULL,updated_at=NEW.updated_at
 WHERE booking_id=NEW.id AND status IN (
   'HOST_PENDING','HOST_APPROVED','ISSUED','GUEST_WAITING','GUEST_ADMITTED'
 );
END;
