import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { googleVerifier } from "./stores/google.js";
import { backupDirFor, pruneRetention } from "./retention.js";

const PORT = Number(process.env.PORT ?? 8091);
const DB_PATH = process.env.DB_PATH ?? "./data/scores.db";

// Google Play purchase checks need a service account key with access to
// the apps in the Play Console; without one they answer "try later".
// Apple's signed transactions need no credentials.
const GOOGLE_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
const google = GOOGLE_KEY && existsSync(GOOGLE_KEY)
  ? googleVerifier(JSON.parse(readFileSync(GOOGLE_KEY, "utf8")))
  : undefined;

const db = openDb(DB_PATH);
const app = createApp(db, {
  purchases: { google, appleRootFingerprint: process.env.APPLE_ROOT_SHA256 || undefined },
});

// Retention runs at startup and then daily; it logs counts only.
function prune() {
  const result = pruneRetention(db, backupDirFor(DB_PATH), Math.floor(Date.now() / 1000));
  if (result.ipsCleared > 0 || result.backupsRemoved.length > 0) {
    console.log(
      `retention: cleared ${result.ipsCleared} old submission IP(s), removed ${result.backupsRemoved.length} old backup(s)`);
  }
}

prune();
setInterval(prune, 24 * 3600 * 1000);

app.listen(PORT, () => {
  console.log(`score-server listening on :${PORT}, db at ${DB_PATH}`);
  console.log(`google purchase checks: ${google ? "on" : "not configured"}`);
});
