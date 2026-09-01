// Seeds the Preferans alltime board with the classic offline top-10, so the
// global leaderboard never looks empty on day one. Idempotent: stable
// player_ids upsert, and the best-score-only rule keeps reruns harmless.
//
// Run on the VPS (or anywhere that can reach the service):
//   PREF_API_KEY=... PREF_HMAC_SECRET=... node scripts/seed-pref.mjs
// Optional: SCORES_URL (default http://127.0.0.1:8091).
//
// Scores are in the client's x10 scale (tenths of a whist): 1000.0 -> 10000.

import { signaturePayload, sign } from "../dist/hmac.js";

const base = process.env.SCORES_URL ?? "http://127.0.0.1:8091";
const apiKey = process.env.PREF_API_KEY;
const secret = process.env.PREF_HMAC_SECRET;

if (!apiKey || !secret) {
  console.error("set PREF_API_KEY and PREF_HMAC_SECRET (see ~/ScoreServer/pref-keys.txt)");
  process.exit(1);
}

const seeds = [
  ["Эйнштейн", 10000],
  ["Да Винчи", 7500],
  ["Перельман", 5000],
  ["Вован", 3000],
  ["Настасья", 2500],
  ["Алексей", 2000],
  ["Андрей", 1500],
  ["Григорий", 1000],
  ["Ирина", 500],
  ["Степан", 0],
];

const path = "/v1/pref/boards/alltime/scores";
let failed = 0;

for (const [i, [name, score]] of seeds.entries()) {
  const body = Buffer.from(
    JSON.stringify({
      player_id: `seed-${i + 1}`,
      name,
      score,
      device_ts: Math.floor(Date.now() / 1000),
    }),
    "utf8",
  );
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(secret, signaturePayload(ts, "POST", path, body));
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "X-Api-Key": apiKey,
      "X-Ts": ts,
      "X-Sig": sig,
      "Content-Type": "application/json",
    },
    body,
  });
  const text = await res.text();
  const ok = res.ok && JSON.parse(text).accepted !== false;
  if (!ok) failed++;
  console.log(`${ok ? "ok " : "FAIL"} ${name} ${score} -> ${res.status} ${text}`);
}

process.exit(failed === 0 ? 0 : 1);
