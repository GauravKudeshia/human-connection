PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mp_host_schedule_blocks (
 id TEXT PRIMARY KEY,
 host_id TEXT NOT NULL REFERENCES mp_users(id),
 starts_at INTEGER NOT NULL,
 ends_at INTEGER NOT NULL,
 time_zone TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 cancelled_at INTEGER,
 request_key TEXT NOT NULL,
 UNIQUE(host_id,request_key),
 CHECK(ends_at>starts_at)
);
CREATE INDEX IF NOT EXISTS mp_host_schedule_blocks_host ON mp_host_schedule_blocks(host_id,starts_at,ends_at);

CREATE TABLE IF NOT EXISTS mp_scheduled_reservations (
 id TEXT PRIMARY KEY,
 block_id TEXT NOT NULL REFERENCES mp_host_schedule_blocks(id),
 customer_id TEXT NOT NULL REFERENCES mp_users(id),
 host_id TEXT NOT NULL REFERENCES mp_users(id),
 starts_at INTEGER NOT NULL,
 ends_at INTEGER NOT NULL,
 protected_from INTEGER NOT NULL,
 protected_until INTEGER NOT NULL,
 check_in_until INTEGER NOT NULL,
 experience TEXT NOT NULL CHECK(experience IN ('laugh','hear','distract')),
 style TEXT,
 duration INTEGER NOT NULL CHECK(duration IN (15,30)),
 format TEXT NOT NULL CHECK(format IN ('audio','video')),
 language TEXT NOT NULL,
 price_cents INTEGER NOT NULL CHECK(price_cents>0),
 currency TEXT NOT NULL CHECK(currency='USD'),
 status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK(status IN ('SCHEDULED','CHECKED_IN','CANCELLED')),
 booking_id TEXT UNIQUE REFERENCES mp_bookings(id),
 request_key TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(customer_id,request_key),
 CHECK(customer_id<>host_id),
 CHECK(starts_at<ends_at AND protected_from<=starts_at AND ends_at<=protected_until),
 CHECK(starts_at<check_in_until AND check_in_until<=protected_until),
 CHECK((status='CHECKED_IN')=(booking_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS mp_scheduled_by_host ON mp_scheduled_reservations(host_id,status,protected_from,protected_until);
CREATE INDEX IF NOT EXISTS mp_scheduled_by_customer ON mp_scheduled_reservations(customer_id,status,protected_from,protected_until);
CREATE INDEX IF NOT EXISTS mp_scheduled_by_block ON mp_scheduled_reservations(block_id,status,check_in_until);

CREATE TRIGGER IF NOT EXISTS mp_scheduled_account_inactive
AFTER UPDATE OF status ON mp_users
WHEN NEW.status<>'ACTIVE' AND OLD.status='ACTIVE'
BEGIN
 UPDATE mp_host_schedule_blocks SET cancelled_at=CAST(strftime('%s','now') AS INTEGER)*1000
 WHERE host_id=NEW.id AND cancelled_at IS NULL;
 UPDATE mp_scheduled_reservations
 SET status='CANCELLED',updated_at=MAX(updated_at,(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER)))
 WHERE status='SCHEDULED' AND check_in_until>(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))
 AND (customer_id=NEW.id OR host_id=NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS mp_scheduled_host_unapproved
AFTER UPDATE OF status ON mp_host_profiles
WHEN OLD.status='APPROVED' AND NEW.status<>'APPROVED'
BEGIN
 UPDATE mp_host_schedule_blocks SET cancelled_at=NEW.updated_at WHERE host_id=NEW.user_id AND cancelled_at IS NULL;
 UPDATE mp_scheduled_reservations SET status='CANCELLED',updated_at=NEW.updated_at
 WHERE host_id=NEW.user_id AND status='SCHEDULED' AND check_in_until>NEW.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS mp_scheduled_pair_blocked
AFTER INSERT ON mp_blocks
BEGIN
 UPDATE mp_scheduled_reservations SET status='CANCELLED',updated_at=NEW.created_at
 WHERE status='SCHEDULED' AND check_in_until>NEW.created_at AND (
   (customer_id=NEW.owner_id AND host_id=NEW.blocked_id) OR
   (host_id=NEW.owner_id AND customer_id=NEW.blocked_id)
 );
END;
