PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mp_intro_captions (
 intro_id TEXT PRIMARY KEY REFERENCES mp_intro_media(id) ON DELETE CASCADE,
 language TEXT NOT NULL CHECK(length(language) BETWEEN 2 AND 64),
 text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) BETWEEN 1 AND 16384)
);
