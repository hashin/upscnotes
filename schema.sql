-- Cloudflare D1 schema — the username registry + the authoritative published-notes index.
-- No note *content* is stored here; note bodies live in each student's Google Drive.
--
-- First run:   cd worker && npx wrangler d1 execute upscnotes --remote --file=../schema.sql
-- Migrating an older DB: run ../migrations/002_publish_index.sql instead.

CREATE TABLE IF NOT EXISTS users (
  sub        TEXT PRIMARY KEY,
  username   TEXT UNIQUE NOT NULL,
  email      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  sub          TEXT PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  display_name TEXT,
  bio          TEXT,
  avatar_url   TEXT,
  updated_at   INTEGER NOT NULL
);

-- The single source of truth for "what is published", keyed by Google account. Any device
-- the student signs into writes here; the public page reads only from here.
CREATE TABLE IF NOT EXISTS pub_notes (
  sub           TEXT NOT NULL,
  note_id       TEXT NOT NULL,
  slug          TEXT NOT NULL,
  title         TEXT NOT NULL,
  tags          TEXT,          -- JSON array
  syllabus      TEXT,          -- JSON array
  drive_file_id TEXT NOT NULL,
  words         INTEGER,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (sub, note_id)
);
CREATE INDEX IF NOT EXISTS idx_pub_notes_sub ON pub_notes (sub);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pub_notes_slug ON pub_notes (sub, slug);

CREATE TABLE IF NOT EXISTS rate_limits (
  id         TEXT PRIMARY KEY,
  n          INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
