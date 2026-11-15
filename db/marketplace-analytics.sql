-- Repeatable local/staging analytics migration. No external tracking or identity linkage.
CREATE TABLE IF NOT EXISTS mp_visit_sessions (
 id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,consent_version TEXT NOT NULL,
 started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,selected_at INTEGER,
 CHECK(expires_at>started_at),CHECK(selected_at IS NULL OR selected_at>=started_at)
);
CREATE INDEX IF NOT EXISTS mp_visits_window ON mp_visit_sessions(started_at);
CREATE TABLE IF NOT EXISTS mp_analytics_coverage (
 name TEXT PRIMARY KEY,began_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_visit_events (
 session_id TEXT NOT NULL REFERENCES mp_visit_sessions(id) ON DELETE CASCADE,
 request_key TEXT NOT NULL,name TEXT NOT NULL CHECK(name='experience_selected'),
 occurred_at INTEGER NOT NULL,PRIMARY KEY(session_id,request_key)
);
CREATE TABLE IF NOT EXISTS mp_match_attempts (
 id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES mp_users(id),request_key TEXT NOT NULL,
 experience TEXT NOT NULL CHECK(experience IN ('laugh','hear','distract')),
 outcome TEXT NOT NULL CHECK(outcome IN ('STARTED','OFFERED','NO_MATCH','FAILED')),
 booking_id TEXT UNIQUE REFERENCES mp_bookings(id),started_at INTEGER NOT NULL,finished_at INTEGER,
 UNIQUE(customer_id,request_key)
);
CREATE INDEX IF NOT EXISTS mp_match_window ON mp_match_attempts(started_at,outcome);
CREATE TABLE IF NOT EXISTS mp_availability_observations (
 host_id TEXT NOT NULL REFERENCES mp_users(id),observed_at INTEGER NOT NULL,
 available INTEGER NOT NULL CHECK(available IN (0,1)),PRIMARY KEY(host_id,observed_at)
);
CREATE INDEX IF NOT EXISTS mp_availability_window ON mp_availability_observations(observed_at);
CREATE TRIGGER IF NOT EXISTS mp_availability_insert AFTER INSERT ON mp_host_presence BEGIN
 INSERT OR IGNORE INTO mp_availability_observations VALUES(NEW.host_id,NEW.last_seen_at,NEW.available);
END;
CREATE TRIGGER IF NOT EXISTS mp_availability_update AFTER UPDATE OF last_seen_at ON mp_host_presence BEGIN
 INSERT INTO mp_availability_observations VALUES(NEW.host_id,NEW.last_seen_at,NEW.available)
 ON CONFLICT(host_id,observed_at) DO UPDATE SET available=excluded.available;
END;
-- Existing heartbeat evidence is retained as a snapshot, never extrapolated before its time.
INSERT OR IGNORE INTO mp_availability_observations SELECT host_id,last_seen_at,available FROM mp_host_presence;
CREATE INDEX IF NOT EXISTS mp_analytics_actor_window ON mp_analytics_events(user_id,occurred_at,name);
CREATE INDEX IF NOT EXISTS mp_booking_event_window ON mp_booking_events(booking_id,action,created_at);
CREATE INDEX IF NOT EXISTS mp_ledger_account_window ON mp_ledger_entries(account,created_at);

-- Named business events are projections of committed authoritative facts, not browser assertions.
CREATE TRIGGER IF NOT EXISTS mp_analytics_capture AFTER INSERT ON mp_ledger_entries
 WHEN NEW.account='processor_clearing' AND NEW.debit_cents>0 AND NEW.event_id='capture:'||NEW.payment_id BEGIN
 INSERT OR IGNORE INTO mp_analytics_events
 SELECT lower(hex(randomblob(16))),b.customer_id,'payment_succeeded',b.id,b.experience,NEW.created_at,'source:payment_succeeded:'||NEW.payment_id
 FROM mp_bookings b WHERE b.id=NEW.booking_id;
END;
CREATE TRIGGER IF NOT EXISTS mp_analytics_join AFTER INSERT ON mp_session_presence BEGIN
 INSERT OR IGNORE INTO mp_analytics_events
 SELECT lower(hex(randomblob(16))),NEW.user_id,'session_joined',b.id,b.experience,NEW.joined_at,'source:session_joined:'||b.id||':'||NEW.session_id
 FROM mp_bookings b WHERE b.id=NEW.booking_id;
END;
CREATE TRIGGER IF NOT EXISTS mp_analytics_session_complete AFTER UPDATE OF status ON mp_bookings
 WHEN NEW.status='COMPLETED' AND OLD.status<>NEW.status BEGIN
 INSERT OR IGNORE INTO mp_analytics_events VALUES(lower(hex(randomblob(16))),NEW.customer_id,'session_completed',NEW.id,NEW.experience,NEW.updated_at,'source:session_completed:'||NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS mp_analytics_session_fail AFTER UPDATE OF status ON mp_bookings
 WHEN NEW.status IN ('FAILED_SERVICE','PARTIAL_DELIVERY','SAFETY_ENDED') AND OLD.status<>NEW.status BEGIN
 INSERT OR IGNORE INTO mp_analytics_events VALUES(lower(hex(randomblob(16))),NEW.customer_id,'session_failed',NEW.id,NEW.experience,NEW.updated_at,'source:session_failed:'||NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS mp_analytics_tip AFTER INSERT ON mp_tips BEGIN
 INSERT OR IGNORE INTO mp_analytics_events
 SELECT lower(hex(randomblob(16))),NEW.customer_id,'tip_submitted',b.id,b.experience,NEW.created_at,'source:tip_submitted:'||NEW.id
 FROM mp_bookings b WHERE b.id=NEW.booking_id;
END;
