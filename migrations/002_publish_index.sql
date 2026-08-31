-- Migrate the v1 registry (profiles held a Drive profile.json pointer) to the v2 model
-- where D1 is the authoritative published-notes index.
--   cd worker && npx wrangler d1 execute upscnotes --remote --file=../migrations/002_publish_index.sql

CREATE TABLE profiles_new (
  sub          TEXT PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  display_name TEXT,
  bio          TEXT,
  avatar_url   TEXT,
  updated_at   INTEGER NOT NULL
);
INSERT OR IGNORE INTO profiles_new (sub, username, updated_at)
  SELECT sub, username, updated_at FROM profiles;
DROP TABLE profiles;
ALTER TABLE profiles_new RENAME TO profiles;

CREATE TABLE IF NOT EXISTS pub_notes (
  sub           TEXT NOT NULL,
  note_id       TEXT NOT NULL,
  slug          TEXT NOT NULL,
  title         TEXT NOT NULL,
  tags          TEXT,
  syllabus      TEXT,
  drive_file_id TEXT NOT NULL,
  words         INTEGER,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (sub, note_id)
);
CREATE INDEX IF NOT EXISTS idx_pub_notes_sub ON pub_notes (sub);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pub_notes_slug ON pub_notes (sub, slug);
