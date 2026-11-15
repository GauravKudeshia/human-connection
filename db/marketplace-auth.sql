CREATE TABLE IF NOT EXISTS mp_auth_transactions (
 id TEXT PRIMARY KEY, nonce_hash TEXT NOT NULL, verifier_cipher TEXT NOT NULL,
 cookie_hash TEXT NOT NULL, return_to TEXT NOT NULL, expires_at INTEGER NOT NULL,
 consumed_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_auth_sessions (
 id TEXT PRIMARY KEY, subject TEXT NOT NULL, expires_at INTEGER NOT NULL,
 revoked_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mp_auth_expiry ON mp_auth_sessions(expires_at);
