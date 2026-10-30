// Deletion requests and retention: temp DB, the real delete-player CLI,
// the API's top list afterwards. Run `npm run build` first.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";

const { openDb } = await import("../dist/db.js");
const { createApp } = await import("../dist/app.js");
const { submitScore } = await import("../dist/scores.js");
const { pruneRetention, backupDirFor } = await import("../dist/retention.js");

const dbPath = join(mkdtempSync(join(tmpdir(), "scores-")), "test.db");
const db = openDb(dbPath);
db.prepare(
  `INSERT INTO games (id, name, api_key, hmac_secret, rotation, payload_private, max_score, min_interval_s)
   VALUES ('demo', 'Demo', 'key', 'secret', 'none', 0, 1000, 0)`,
).run();
const game = db.prepare(`SELECT * FROM games WHERE id = 'demo'`).get();

const now = Math.floor(Date.now() / 1000);
const IVAN_A = "aaaaaaaa-0000-0000-0000-000000000001";
const IVAN_B = "bbbbbbbb-0000-0000-0000-000000000002";
const BOB = "cccccccc-0000-0000-0000-000000000003";
submitScore(db, game, "alltime", IVAN_A, "Иван", 300, undefined, "10.0.0.1", now - 50);
submitScore(db, game, "alltime", IVAN_A, "Иван", 500, undefined, "10.0.0.1", now - 40);
submitScore(db, game, "total:2026-10", IVAN_A, "Иван", -50, undefined, "10.0.0.1", now - 30);
submitScore(db, game, "alltime", IVAN_A, "Иван", -5, undefined, "10.0.0.1", now - 20); // rejected, still logged
submitScore(db, game, "alltime", IVAN_B, "иван ", 400, undefined, "10.0.0.2", now - 10);
submitScore(db, game, "alltime", BOB, "Bob", 200, undefined, "10.0.0.3", now - 5);
db.prepare(`INSERT INTO deal_access VALUES ('demo', '2026-10', 0, ?, ?)`).run(IVAN_A, now);

function run(...args) {
  try {
    return { code: 0, out: execFileSync("node", ["dist/delete-player.js", ...args], {
      env: { ...process.env, DB_PATH: dbPath }, encoding: "utf8", stdio: "pipe" }) };
  } catch (error) {
    return { code: error.status, out: error.stdout + error.stderr };
  }
}

const count = (table, id) =>
  db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE player_id = ?`).get(id).n;

// A shared name lists both players (case and spaces folded, Cyrillic too)
// and refuses to pick one.
let r = run("--game", "demo", "--name", "ИВАН");
assert.equal(r.code, 2, r.out);
assert.ok(r.out.includes(IVAN_A) && r.out.includes(IVAN_B), r.out);
r = run("--game", "demo", "--name", "ИВАН", "--confirm");
assert.equal(r.code, 2, r.out);
assert.equal(count("scores", IVAN_A), 2);

// Dry run (the default) reports exact counts and deletes nothing.
r = run("--game", "demo", "--name", "Иван", "--player-id", IVAN_A);
assert.equal(r.code, 0, r.out);
assert.match(r.out, /would delete \(dry run\)/);
assert.match(r.out, /table scores: 2\n/);
assert.match(r.out, /table submissions: 4\n/);
assert.match(r.out, /table deal_access: 1\n/);
assert.match(r.out, /ip 10\.0\.0\.1/);
assert.equal(count("submissions", IVAN_A), 4);

// An id that never used the name is refused.
r = run("--game", "demo", "--name", "Иван", "--player-id", BOB);
assert.equal(r.code, 1, r.out);

// --board limits the deletion to one board.
r = run("--game", "demo", "--player-id", IVAN_A, "--board", "total:2026-10", "--confirm");
assert.equal(r.code, 0, r.out);
assert.match(r.out, /deleted: scores 1, submissions 1, deal_access 0/);
assert.equal(count("scores", IVAN_A), 1);

// Confirm: backup first, then every row of that player goes.
r = run("--game", "demo", "--name", "Иван", "--player-id", IVAN_A, "--confirm");
assert.equal(r.code, 0, r.out);
assert.match(r.out, /deleted: scores 1, submissions 3, deal_access 1/);
for (const table of ["scores", "submissions", "deal_access"]) {
  assert.equal(count(table, IVAN_A), 0, table);
}
assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE ip = '10.0.0.1'`).get().n, 0);
assert.equal(count("scores", IVAN_B), 1);
assert.equal(count("scores", BOB), 1);
const backups = readdirSync(backupDirFor(dbPath));
assert.equal(backups.length, 2);
assert.ok(backups.every((f) => f.startsWith("pre-delete-")));

// Gone from the API at once (rankings are computed per read).
const server = createApp(db).listen(0);
const top = await (await fetch(`http://127.0.0.1:${server.address().port}/v1/demo/boards/alltime/top`, {
  headers: { "X-Api-Key": "key" } })).json();
server.close();
assert.deepEqual(top.entries.map((e) => [e.rank, e.player_id]), [[1, IVAN_B], [2, BOB]]);

// Idempotent: a second run finds nothing and takes no backup.
r = run("--game", "demo", "--player-id", IVAN_A, "--confirm");
assert.equal(r.code, 0, r.out);
assert.match(r.out, /nothing to delete/);
assert.equal(readdirSync(backupDirFor(dbPath)).length, 2);

// Unknown names are fine in a dry run.
r = run("--game", "demo", "--name", "nobody-here");
assert.equal(r.code, 0, r.out);
assert.match(r.out, /0 player\(s\)[\s\S]*nothing to delete/);

// Retention: IPs older than 90 days are cleared (the rows stay), and
// pre-delete backups older than 7 days are removed; other files stay.
submitScore(db, game, "alltime", BOB, "Bob", 100, undefined, "10.0.0.9", now - 91 * 86400);
const dir = backupDirFor(dbPath);
const old = join(dir, backups[0]);
const oldS = now - 8 * 86400;
utimesSync(old, oldS, oldS);
writeFileSync(join(dir, "manual.db"), "");
utimesSync(join(dir, "manual.db"), oldS, oldS);
const pruned = pruneRetention(db, dir, now);
assert.equal(pruned.ipsCleared, 1);
assert.deepEqual(pruned.backupsRemoved, [backups[0]]);
assert.deepEqual(readdirSync(dir).sort(), [backups[1], "manual.db"].sort());
assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE ip IS NULL`).get().n, 1);
assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE player_id = ?`).get(BOB).n, 2);
assert.equal(pruneRetention(db, dir, now).ipsCleared, 0);

console.log("delete-player OK");
