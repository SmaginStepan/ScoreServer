import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { googleVerifier } from "./stores/google.js";

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

app.listen(PORT, () => {
  console.log(`score-server listening on :${PORT}, db at ${DB_PATH}`);
  console.log(`google purchase checks: ${google ? "on" : "not configured"}`);
});
