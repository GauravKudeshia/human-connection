PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mp_host_interests (
 host_id TEXT PRIMARY KEY REFERENCES mp_host_profiles(user_id),
 interests TEXT NOT NULL CHECK(json_valid(interests) AND json_type(interests)='array')
);

CREATE TRIGGER IF NOT EXISTS mp_host_application_submitted
AFTER INSERT ON mp_host_profiles
WHEN NEW.status='SUBMITTED'
BEGIN
 INSERT OR IGNORE INTO mp_analytics_events
  VALUES(lower(hex(randomblob(16))),NEW.user_id,'host_application_submitted',NULL,NULL,NEW.updated_at,'source:host_application_submitted');
END;

CREATE TRIGGER IF NOT EXISTS mp_host_application_status
AFTER UPDATE OF status ON mp_host_profiles
WHEN OLD.status<>NEW.status AND NEW.status IN ('SUBMITTED','APPROVED')
BEGIN
 INSERT OR IGNORE INTO mp_analytics_events
  VALUES(lower(hex(randomblob(16))),NEW.user_id,'host_application_'||lower(NEW.status),NULL,NULL,NEW.updated_at,
    'source:host_application_'||lower(NEW.status));
END;
