import { randomBytes } from "node:crypto";
import type { Db, Game } from "./db.js";

export interface Season {
  game_id: string;
  season_id: string;
  starts_at: number;
  ends_at: number;
  payload: string | null;
}

// The server is the single source of truth for "what season is it":
// clients never compute week numbers locally. Explicitly created
// seasons (admin CLI) always win; when none covers `now` and the game
// has a rotation rule, a season is auto-created with a random seed
// payload.
export function currentSeason(db: Db, game: Game, nowS: number): Season | null {
  const existing = db
    .prepare(
      `SELECT * FROM seasons
       WHERE game_id = ? AND starts_at <= ? AND ends_at > ?
       ORDER BY starts_at DESC LIMIT 1`,
    )
    .get(game.id, nowS, nowS) as Season | undefined;

  if (existing) {
    return existing;
  }

  if (game.rotation === "none") {
    return null;
  }

  const window =
    game.rotation === "weekly" ? isoWeekWindow(nowS) : monthWindow(nowS);
  const payload = JSON.stringify({ seed: randomBytes(16).toString("hex") });

  // INSERT OR IGNORE + re-select keeps concurrent first requests safe:
  // whoever loses the race reads the winner's row (and seed).
  db.prepare(
    `INSERT OR IGNORE INTO seasons (game_id, season_id, starts_at, ends_at, payload)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(game.id, window.id, window.start, window.end, payload);

  return db
    .prepare(`SELECT * FROM seasons WHERE game_id = ? AND season_id = ?`)
    .get(game.id, window.id) as Season;
}

interface Window {
  id: string;
  start: number;
  end: number;
}

// ISO-8601 week (Monday start, week 1 contains the first Thursday),
// all in UTC.
function isoWeekWindow(nowS: number): Window {
  const now = new Date(nowS * 1000);
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  // Monday of the current week.
  const weekday = (day.getUTCDay() + 6) % 7; // Mon = 0
  const monday = new Date(day);
  monday.setUTCDate(day.getUTCDate() - weekday);

  // ISO week number: the week's Thursday determines the ISO year.
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);

  const start = monday.getTime() / 1000;
  return {
    id: `${isoYear}-W${String(week).padStart(2, "0")}`,
    start,
    end: start + 7 * 86400,
  };
}

function monthWindow(nowS: number): Window {
  const now = new Date(nowS * 1000);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    id: `${y}-${String(m + 1).padStart(2, "0")}`,
    start: Date.UTC(y, m, 1) / 1000,
    end: Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1) / 1000,
  };
}

// Private-payload games (duplicate bridge): the payload is expected to
// be {"deals": [...]}; a single deal is served on demand and the first
// access per player is logged for anti-peek audits.
export function dealForIndex(
  db: Db,
  game: Game,
  season: Season,
  index: number,
  playerId: string,
  nowS: number,
): { deal: unknown } | { error: string } {
  if (!season.payload) {
    return { error: "season has no payload" };
  }

  let deals: unknown[];
  try {
    const parsed = JSON.parse(season.payload) as { deals?: unknown[] };
    if (!Array.isArray(parsed.deals)) {
      return { error: "season payload has no deals array" };
    }
    deals = parsed.deals;
  } catch {
    return { error: "season payload is not valid JSON" };
  }

  if (index < 0 || index >= deals.length) {
    return { error: "deal index out of range" };
  }

  db.prepare(
    `INSERT OR IGNORE INTO deal_access (game_id, season_id, deal_index, player_id, first_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(game.id, season.season_id, index, playerId, nowS);

  return { deal: deals[index] };
}
