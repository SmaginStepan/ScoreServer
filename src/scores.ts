import type { Db, Game } from "./db.js";

export interface Entry {
  rank: number;
  player_id: string;
  name: string;
  score: number;
}

export interface SubmitResult {
  accepted: boolean;
  reason?: string;
  best: number;
  rank: number | null;
}

// Submissions always land in the audit table; the visible board keeps
// only each player's best score. Ties rank by who got there first.
export function submitScore(
  db: Db,
  game: Game,
  boardId: string,
  playerId: string,
  name: string,
  score: number,
  deviceTs: number | undefined,
  ip: string | undefined,
  nowS: number,
): SubmitResult {
  let accepted = true;
  let reason: string | undefined;

  if (score < 0 || !Number.isSafeInteger(score)) {
    accepted = false;
    reason = "score out of range";
  } else if (game.max_score !== null && score > game.max_score) {
    accepted = false;
    reason = "score above game maximum";
  } else if (game.min_interval_s > 0) {
    const last = db
      .prepare(
        `SELECT server_ts FROM submissions
         WHERE game_id = ? AND board_id = ? AND player_id = ? AND accepted = 1
         ORDER BY server_ts DESC LIMIT 1`,
      )
      .get(game.id, boardId, playerId) as { server_ts: number } | undefined;
    if (last && nowS - last.server_ts < game.min_interval_s) {
      accepted = false;
      reason = "submitting too fast";
    }
  }

  db.prepare(
    `INSERT INTO submissions (game_id, board_id, player_id, name, score, device_ts, server_ts, ip, accepted, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    game.id,
    boardId,
    playerId,
    name,
    score,
    deviceTs ?? null,
    nowS,
    ip ?? null,
    accepted ? 1 : 0,
    reason ?? null,
  );

  // Every accepted submit carries the player's current name (a rename
  // shows without a new best); score and the tie-breaking time move only
  // on a new best.
  if (accepted) {
    db.prepare(
      `INSERT INTO scores (game_id, board_id, player_id, name, score, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (game_id, board_id, player_id) DO UPDATE SET
         name = excluded.name,
         score = MAX(scores.score, excluded.score),
         updated_at = CASE WHEN excluded.score > scores.score
                           THEN excluded.updated_at ELSE scores.updated_at END`,
    ).run(game.id, boardId, playerId, name, score, nowS);
  }

  const row = db
    .prepare(
      `SELECT score FROM scores WHERE game_id = ? AND board_id = ? AND player_id = ?`,
    )
    .get(game.id, boardId, playerId) as { score: number } | undefined;

  return {
    accepted,
    reason,
    best: row?.score ?? 0,
    rank: row ? rankOf(db, game.id, boardId, playerId) : null,
  };
}

export function rankOf(
  db: Db,
  gameId: string,
  boardId: string,
  playerId: string,
): number | null {
  const mine = db
    .prepare(
      `SELECT score, updated_at FROM scores
       WHERE game_id = ? AND board_id = ? AND player_id = ?`,
    )
    .get(gameId, boardId, playerId) as
    | { score: number; updated_at: number }
    | undefined;

  if (!mine) {
    return null;
  }

  const better = db
    .prepare(
      `SELECT COUNT(*) AS n FROM scores
       WHERE game_id = ? AND board_id = ?
         AND (score > ? OR (score = ? AND updated_at < ?))`,
    )
    .get(gameId, boardId, mine.score, mine.score, mine.updated_at) as { n: number };

  return better.n + 1;
}

export function top(db: Db, gameId: string, boardId: string, limit: number): Entry[] {
  const rows = db
    .prepare(
      `SELECT player_id, name, score FROM scores
       WHERE game_id = ? AND board_id = ?
       ORDER BY score DESC, updated_at ASC LIMIT ?`,
    )
    .all(gameId, boardId, limit) as Omit<Entry, "rank">[];

  return rows.map((row, i) => ({ rank: i + 1, ...row }));
}

// The "you are #1234" view: the player's row with `span` neighbors on
// each side.
export function around(
  db: Db,
  gameId: string,
  boardId: string,
  playerId: string,
  span: number,
): Entry[] {
  const rank = rankOf(db, gameId, boardId, playerId);
  if (rank === null) {
    return [];
  }

  const offset = Math.max(0, rank - 1 - span);
  const rows = db
    .prepare(
      `SELECT player_id, name, score FROM scores
       WHERE game_id = ? AND board_id = ?
       ORDER BY score DESC, updated_at ASC LIMIT ? OFFSET ?`,
    )
    .all(gameId, boardId, span * 2 + 1, offset) as Omit<Entry, "rank">[];

  return rows.map((row, i) => ({ rank: offset + i + 1, ...row }));
}
