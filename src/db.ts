import Database from "better-sqlite3";

// One SQLite file holds every game's boards, seasons and audit trail.
// WAL keeps concurrent reads cheap; the write volume of a leaderboard
// is far below anything SQLite would notice.
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      api_key         TEXT NOT NULL UNIQUE,
      hmac_secret     TEXT NOT NULL,
      -- 'none' | 'weekly' | 'monthly': how season/current auto-creates
      -- seasons when no explicit row covers the current time.
      rotation        TEXT NOT NULL DEFAULT 'none',
      -- 1: the season payload is never returned whole; clients fetch
      -- deals one by one and every access is logged (duplicate-bridge
      -- anti-peek).
      payload_private INTEGER NOT NULL DEFAULT 0,
      -- Sanity limits for submissions; NULL max_score disables the cap.
      max_score       INTEGER,
      min_interval_s  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS seasons (
      game_id   TEXT NOT NULL,
      season_id TEXT NOT NULL,
      starts_at INTEGER NOT NULL,
      ends_at   INTEGER NOT NULL,
      -- Opaque JSON the service stores but does not interpret (deal
      -- seeds for bridge, empty for score-period-only games).
      payload   TEXT,
      PRIMARY KEY (game_id, season_id)
    );

    -- One row per player per board, keeping the player's best score.
    CREATE TABLE IF NOT EXISTS scores (
      game_id    TEXT NOT NULL,
      board_id   TEXT NOT NULL,
      player_id  TEXT NOT NULL,
      name       TEXT NOT NULL,
      score      INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (game_id, board_id, player_id)
    );
    CREATE INDEX IF NOT EXISTS idx_scores_board
      ON scores (game_id, board_id, score DESC, updated_at ASC);

    -- Raw audit trail of every submission, accepted or not: the basis
    -- for retro-banning and dispute checks.
    CREATE TABLE IF NOT EXISTS submissions (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id   TEXT NOT NULL,
      board_id  TEXT NOT NULL,
      player_id TEXT NOT NULL,
      name      TEXT NOT NULL,
      score     INTEGER NOT NULL,
      device_ts INTEGER,
      server_ts INTEGER NOT NULL,
      ip        TEXT,
      accepted  INTEGER NOT NULL,
      reason    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_submissions_player
      ON submissions (game_id, board_id, player_id, server_ts DESC);

    -- Who saw which private deal when (duplicate-bridge audit).
    CREATE TABLE IF NOT EXISTS deal_access (
      game_id       TEXT NOT NULL,
      season_id     TEXT NOT NULL,
      deal_index    INTEGER NOT NULL,
      player_id     TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      PRIMARY KEY (game_id, season_id, deal_index, player_id)
    );
  `);
  return db;
}

export type Db = Database.Database;

export interface Game {
  id: string;
  name: string;
  api_key: string;
  hmac_secret: string;
  rotation: "none" | "weekly" | "monthly";
  payload_private: number;
  max_score: number | null;
  min_interval_s: number;
}
