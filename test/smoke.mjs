// End-to-end smoke: temp DB, in-process app, one game, signed submits,
// season rotation, top/around/rank. Run `npm run build` first.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";

const { openDb } = await import("../dist/db.js");
const { createApp } = await import("../dist/app.js");

const db = openDb(join(mkdtempSync(join(tmpdir(), "scores-")), "test.db"));
const apiKey = randomBytes(8).toString("hex");
const secret = randomBytes(16).toString("hex");
db.prepare(
  `INSERT INTO games (id, name, api_key, hmac_secret, rotation, payload_private, max_score, min_interval_s)
   VALUES ('demo', 'Demo', ?, ?, 'weekly', 0, 1000, 0)`,
).run(apiKey, secret);

const server = createApp(db).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

function signedHeaders(path, bodyText) {
  const ts = String(Math.floor(Date.now() / 1000));
  const bodyHash = createHash("sha256").update(Buffer.from(bodyText)).digest("hex");
  const sig = createHmac("sha256", secret)
    .update(`${ts}\nPOST\n${path}\n${bodyHash}`)
    .digest("hex");
  return { "Content-Type": "application/json", "X-Api-Key": apiKey, "X-Ts": ts, "X-Sig": sig };
}

async function submit(board, playerId, name, score) {
  const path = `/v1/demo/boards/${board}/scores`;
  const body = JSON.stringify({ player_id: playerId, name, score });
  const res = await fetch(base + path, { method: "POST", headers: signedHeaders(path, body), body });
  return res.json();
}

// Season auto-rotation produces a stable weekly id with a seed payload.
const season = await (await fetch(`${base}/v1/demo/season/current`, { headers: { "X-Api-Key": apiKey } })).json();
assert.match(season.season_id, /^\d{4}-W\d{2}$/, "weekly season id");
assert.ok(JSON.parse(season.payload).seed, "auto season carries a seed");

// Unsigned writes and bad keys are rejected.
const unsigned = await fetch(`${base}/v1/demo/boards/main/scores`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
  body: JSON.stringify({ player_id: "p1", name: "A", score: 10 }),
});
assert.equal(unsigned.status, 401, "unsigned write must be rejected");

// Best-score semantics and ranking.
assert.equal((await submit("main", "p1", "Alice", 100)).accepted, true);
assert.equal((await submit("main", "p1", "Alice", 50)).best, 100, "lower score keeps best");
assert.equal((await submit("main", "p2", "Bob", 200)).rank, 1);
assert.equal((await submit("main", "p3", "Cara", 150)).rank, 2);

// Sanity cap.
const capped = await submit("main", "p4", "Mallory", 5000);
assert.equal(capped.accepted, false, "score above max must be rejected");

const topResponse = await (await fetch(`${base}/v1/demo/boards/main/top?limit=10`, {
  headers: { "X-Api-Key": apiKey },
})).json();
assert.deepEqual(
  topResponse.entries.map((entry) => entry.player_id),
  ["p2", "p3", "p1"],
  "top order",
);

const aroundResponse = await (await fetch(`${base}/v1/demo/boards/main/around/p3?span=1`, {
  headers: { "X-Api-Key": apiKey },
})).json();
assert.equal(aroundResponse.entries.length, 3);
assert.equal(aroundResponse.entries[1].player_id, "p3");

const rankResponse = await (await fetch(`${base}/v1/demo/boards/main/rank/p1`, {
  headers: { "X-Api-Key": apiKey },
})).json();
assert.equal(rankResponse.rank, 3);

server.close();
console.log("smoke ok");
