-- Cloudflare D1 schema. Run once:
--   npx wrangler d1 execute upscnotes --remote --file=schema.sql
--
-- This holds ONLY the username registry (username -> public profile pointer).
-- No note content is ever stored here — notes live in each student's Google Drive.

CREATE TABLE IF NOT EXISTS users (
  sub        TEXT PRIMARY KEY,          -- Google account subject id
  username   TEXT UNIQUE NOT NULL,
  email      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  username        TEXT PRIMARY KEY,
  sub             TEXT NOT NULL,
  profile_url     TEXT NOT NULL,        -- anyone-with-link URL of profile.json in the user's Drive
  profile_file_id TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profiles_sub ON profiles (sub);

CREATE TABLE IF NOT EXISTS rate_limits (
  id         TEXT PRIMARY KEY,
  n          INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
