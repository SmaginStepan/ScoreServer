import "dotenv/config";
import { openDb } from "./db.js";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 8091);
const DB_PATH = process.env.DB_PATH ?? "./data/scores.db";

const db = openDb(DB_PATH);
const app = createApp(db);

app.listen(PORT, () => {
  console.log(`score-server listening on :${PORT}, db at ${DB_PATH}`);
});
