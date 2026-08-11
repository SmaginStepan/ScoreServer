import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { openDb } from "./db.js";

// Operator CLI, run on the VPS next to the database:
//   npm run admin -- register-game xlab "XLab" --rotation weekly --min-interval 10
//   npm run admin -- set-limits xlab --max-score 100000 --min-interval 10
//   npm run admin -- create-season bridge 2026-S1 2026-08-01 2026-11-01 --payload-file deals.json
//   npm run admin -- list-games
//   npm run admin -- list-seasons bridge

const DB_PATH = process.env.DB_PATH ?? "./data/scores.db";
const db = openDb(DB_PATH);

const [command, ...args] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

switch (command) {
  case "register-game": {
    const [id, name] = args;
    if (!id || !name) {
      console.error("usage: register-game <id> <name> [--rotation weekly|monthly] [--private-payload] [--max-score N] [--min-interval S]");
      process.exit(1);
    }

    const apiKey = randomBytes(16).toString("hex");
    const hmacSecret = randomBytes(32).toString("hex");
    db.prepare(
      `INSERT INTO games (id, name, api_key, hmac_secret, rotation, payload_private, max_score, min_interval_s)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      apiKey,
      hmacSecret,
      flag("rotation") ?? "none",
      hasFlag("private-payload") ? 1 : 0,
      flag("max-score") ? Number(flag("max-score")) : null,
      flag("min-interval") ? Number(flag("min-interval")) : 0,
    );

    console.log(`registered ${id}`);
    console.log(`  api_key:     ${apiKey}`);
    console.log(`  hmac_secret: ${hmacSecret}`);
    break;
  }

  case "set-limits": {
    const [id] = args;
    const game = db.prepare(`SELECT id FROM games WHERE id = ?`).get(id);
    if (!game) {
      console.error(`no game '${id}'`);
      process.exit(1);
    }

    if (flag("max-score") !== undefined) {
      db.prepare(`UPDATE games SET max_score = ? WHERE id = ?`).run(Number(flag("max-score")), id);
    }

    if (flag("min-interval") !== undefined) {
      db.prepare(`UPDATE games SET min_interval_s = ? WHERE id = ?`).run(Number(flag("min-interval")), id);
    }

    console.log("updated");
    break;
  }

  case "create-season": {
    const [gameId, seasonId, startsIso, endsIso] = args;
    if (!gameId || !seasonId || !startsIso || !endsIso) {
      console.error("usage: create-season <game> <season_id> <starts_iso> <ends_iso> [--payload-file f.json]");
      process.exit(1);
    }

    const payloadFile = flag("payload-file");
    const payload = payloadFile ? readFileSync(payloadFile, "utf8") : null;
    db.prepare(
      `INSERT INTO seasons (game_id, season_id, starts_at, ends_at, payload)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      gameId,
      seasonId,
      Math.floor(Date.parse(startsIso) / 1000),
      Math.floor(Date.parse(endsIso) / 1000),
      payload,
    );

    console.log(`season ${seasonId} created for ${gameId}`);
    break;
  }

  case "list-games": {
    for (const game of db.prepare(`SELECT id, name, rotation, payload_private, max_score, min_interval_s FROM games`).all()) {
      console.log(JSON.stringify(game));
    }
    break;
  }

  case "list-seasons": {
    for (const season of db
      .prepare(`SELECT season_id, starts_at, ends_at, length(payload) AS payload_bytes FROM seasons WHERE game_id = ? ORDER BY starts_at`)
      .all(args[0])) {
      console.log(JSON.stringify(season));
    }
    break;
  }

  default:
    console.error("commands: register-game, set-limits, create-season, list-games, list-seasons");
    process.exit(1);
}
