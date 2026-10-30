import "dotenv/config";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.js";
import { PRE_DELETE_BACKUP_PREFIX, backupDirFor } from "./retention.js";

// Removes one player's data on a deletion request (privacy policy, "Delete
// Your Data"): their board entries, every submission-log row (with the IP)
// and their deal-access rows. Rankings are computed from the scores table
// on every read, so the player is off the boards as soon as this commits.
// Store purchases are not touched: they are not leaderboard data and
// guard against a receipt being granted twice.
//
// Dry run unless --confirm. Run on the VPS:
//   docker exec score_server node dist/delete-player.js --game pref --name "Ivan"
//   docker exec score_server node dist/delete-player.js --game pref --name "Ivan" --player-id <uuid> --confirm
//
//   --game <id>        required: the game the request is about
//   --name <name>      exact display name, case-insensitive, trimmed; any
//                      name the player has submitted under counts
//   --player-id <id>   the player to delete; required when the name
//                      matches several players
//   --all-matching     delete every player matching --name
//   --board <id>       only this board (and its log rows)
//   --all-rows         print every log row instead of the first 50
//   --dry-run          the default; only reports
//   --confirm          back up the database, then delete

const DB_PATH = process.env.DB_PATH ?? "./data/scores.db";
const ROW_PREVIEW = 50;

const args = process.argv.slice(2);
const VALUE_FLAGS = ["game", "name", "player-id", "board"];
const SWITCHES = ["all-matching", "all-rows", "dry-run", "confirm"];

function usage(message: string): never {
  console.error(message);
  console.error(
    "usage: delete-player --game <id> (--name <name> | --player-id <id>) [--player-id <id> | --all-matching] [--board <id>] [--all-rows] [--dry-run | --confirm]");
  process.exit(1);
}

const options = new Map<string, string>();
const switches = new Set<string>();
for (let i = 0; i < args.length; i++) {
  const key = args[i]!.replace(/^--/, "");
  if (VALUE_FLAGS.includes(key)) {
    const value = args[++i];
    if (value === undefined) {
      usage(`--${key} needs a value`);
    }

    options.set(key, value);
  } else if (SWITCHES.includes(key)) {
    switches.add(key);
  } else {
    usage(`unknown argument '${args[i]}'`);
  }
}

const gameId = options.get("game");
const name = options.get("name");
const playerId = options.get("player-id");
const boardId = options.get("board");
const confirm = switches.has("confirm");

if (!gameId) {
  usage("--game is required");
}

if (!name && !playerId) {
  usage("give --name or --player-id");
}

if (confirm && switches.has("dry-run")) {
  usage("--dry-run and --confirm together make no sense");
}

if (playerId && switches.has("all-matching")) {
  usage("--player-id and --all-matching together make no sense");
}

const db = openDb(DB_PATH);
if (!db.prepare(`SELECT 1 FROM games WHERE id = ?`).get(gameId)) {
  usage(`no game '${gameId}'`);
}

// Unicode-aware folding in JS: SQLite's lower() only folds ASCII, and many
// names here are Cyrillic.
const fold = (s: string) => s.normalize("NFC").trim().toLocaleLowerCase();
const iso = (s: number) => new Date(s * 1000).toISOString().replace(".000Z", "Z");

// Everyone who ever used this name in this game, in the log or on a board.
function playersNamed(target: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT player_id, name FROM submissions WHERE game_id = ?
       UNION SELECT player_id, name FROM scores WHERE game_id = ?`)
    .all(gameId, gameId) as { player_id: string; name: string }[];
  const wanted = fold(target);
  return [...new Set(rows.filter((r) => fold(r.name) === wanted).map((r) => r.player_id))].sort();
}

function describe(id: string) {
  const names = (db
    .prepare(
      `SELECT name FROM submissions WHERE game_id = ? AND player_id = ?
       UNION SELECT name FROM scores WHERE game_id = ? AND player_id = ?`)
    .all(gameId, id, gameId, id) as { name: string }[]).map((r) => r.name);
  const last = db
    .prepare(`SELECT MAX(server_ts) AS ts FROM submissions WHERE game_id = ? AND player_id = ?`)
    .get(gameId, id) as { ts: number | null };
  const boards = db
    .prepare(`SELECT board_id, score FROM scores WHERE game_id = ? AND player_id = ? ORDER BY board_id`)
    .all(gameId, id) as { board_id: string; score: number }[];

  console.log(`  ${id}`);
  console.log(`    names: ${names.map((n) => JSON.stringify(n)).join(", ")}`);
  console.log(`    last submission: ${last.ts ? iso(last.ts) : "none"}`);
  for (const board of boards) {
    console.log(`    ${board.board_id}: ${board.score}`);
  }
}

let targets: string[];
if (name) {
  const matches = playersNamed(name);
  console.log(`game ${gameId}: ${matches.length} player(s) named ${JSON.stringify(name.trim())}`);
  matches.forEach(describe);

  if (playerId) {
    if (!matches.includes(playerId)) {
      console.error(
        `player ${playerId} never used that name in ${gameId}; check the id, or drop --name to go by id alone`);
      process.exit(1);
    }

    targets = [playerId];
  } else if (matches.length > 1 && !switches.has("all-matching")) {
    // Names are not unique and not proof of ownership.
    console.error(
      "several players use this name: pick one with --player-id (ask the requester for it or when they played), or pass --all-matching");
    process.exit(2);
  } else {
    targets = matches;
  }
} else {
  targets = [playerId!];
  console.log(`game ${gameId}: player ${playerId}`);
  describe(playerId!);
}

// What goes, per target. With --board only that board's entry and log rows.
const boardClause = boardId ? " AND board_id = ?" : "";
const scope = (id: string) => (boardId ? [gameId, id, boardId] : [gameId, id]);

interface LogRow {
  id: number;
  player_id: string;
  board_id: string;
  name: string;
  score: number;
  server_ts: number;
  ip: string | null;
  accepted: number;
}

const plan = targets.map((id) => ({
  id,
  scores: db
    .prepare(`SELECT board_id, name, score FROM scores WHERE game_id = ? AND player_id = ?${boardClause} ORDER BY board_id`)
    .all(...scope(id)) as { board_id: string; name: string; score: number }[],
  log: db
    .prepare(
      `SELECT id, player_id, board_id, name, score, server_ts, ip, accepted FROM submissions
       WHERE game_id = ? AND player_id = ?${boardClause} ORDER BY server_ts, id`)
    .all(...scope(id)) as LogRow[],
  deals: boardId
    ? 0
    : (db.prepare(`SELECT COUNT(*) AS n FROM deal_access WHERE game_id = ? AND player_id = ?`)
        .get(gameId, id) as { n: number }).n,
  purchases: (db.prepare(`SELECT COUNT(*) AS n FROM purchases WHERE game_id = ? AND player_id = ?`)
    .get(gameId, id) as { n: number }).n,
}));

const totals = {
  scores: plan.reduce((n, p) => n + p.scores.length, 0),
  submissions: plan.reduce((n, p) => n + p.log.length, 0),
  deal_access: plan.reduce((n, p) => n + p.deals, 0),
};

console.log("");
console.log(confirm ? "deleting:" : "would delete (dry run):");
const perBoard = new Map<string, { scores: number; submissions: number }>();
for (const p of plan) {
  for (const s of p.scores) {
    const b = perBoard.get(s.board_id) ?? { scores: 0, submissions: 0 };
    b.scores++;
    perBoard.set(s.board_id, b);
  }

  for (const r of p.log) {
    const b = perBoard.get(r.board_id) ?? { scores: 0, submissions: 0 };
    b.submissions++;
    perBoard.set(r.board_id, b);
  }
}

for (const [board, n] of [...perBoard].sort()) {
  console.log(`  board ${board}: ${n.scores} entry, ${n.submissions} log row(s)`);
}

console.log(`  table scores: ${totals.scores}`);
console.log(`  table submissions: ${totals.submissions}`);
console.log(`  table deal_access: ${totals.deal_access}`);

const rows = plan.flatMap((p) => p.log);
const shown = switches.has("all-rows") ? rows : rows.slice(0, ROW_PREVIEW);
if (shown.length > 0) {
  console.log("  submission log rows:");
  for (const r of shown) {
    console.log(
      `    #${r.id} ${iso(r.server_ts)} ${r.player_id} ${r.board_id} ${JSON.stringify(r.name)} ${r.score}` +
      ` ${r.accepted ? "accepted" : "rejected"} ip ${r.ip ?? "-"}`);
  }

  if (rows.length > shown.length) {
    console.log(`    ... and ${rows.length - shown.length} more (--all-rows lists them)`);
  }
}

const purchases = plan.reduce((n, p) => n + p.purchases, 0);
if (purchases > 0) {
  console.log(`  kept: ${purchases} store purchase record(s) (not leaderboard data)`);
}

const nothing = totals.scores + totals.submissions + totals.deal_access === 0;
if (nothing) {
  console.log("nothing to delete");
  process.exit(0);
}

if (!confirm) {
  console.log("dry run: nothing deleted; add --confirm to delete");
  process.exit(0);
}

// The backup still holds this player's data; the server's daily retention
// pass removes it after PRE_DELETE_BACKUP_DAYS.
const backupDir = backupDirFor(DB_PATH);
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(backupDir, `${PRE_DELETE_BACKUP_PREFIX}${stamp}.db`);
await db.backup(backupPath);
console.log(`backup: ${backupPath}`);

// All or nothing.
const removed = db.transaction(() => {
  const done = { scores: 0, submissions: 0, deal_access: 0 };
  for (const id of targets) {
    done.scores += db.prepare(`DELETE FROM scores WHERE game_id = ? AND player_id = ?${boardClause}`).run(...scope(id)).changes;
    done.submissions += db.prepare(`DELETE FROM submissions WHERE game_id = ? AND player_id = ?${boardClause}`).run(...scope(id)).changes;
    if (!boardId) {
      done.deal_access += db.prepare(`DELETE FROM deal_access WHERE game_id = ? AND player_id = ?`).run(gameId, id).changes;
    }
  }

  return done;
})();

console.log(
  `deleted: scores ${removed.scores}, submissions ${removed.submissions}, deal_access ${removed.deal_access}`);
