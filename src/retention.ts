import { readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "./db.js";

// How long personal data is kept outside the leaderboard itself (the
// privacy policy quotes these numbers; change both together).
//
// The submission log keeps its rows (player, score, time: what retro-bans
// and the min-interval rule need) but forgets the IP address after
// SUBMISSION_IP_DAYS. The backups taken before a player deletion still
// hold that player's data, so they go after PRE_DELETE_BACKUP_DAYS.
export const SUBMISSION_IP_DAYS = 90;
export const PRE_DELETE_BACKUP_DAYS = 7;
export const PRE_DELETE_BACKUP_PREFIX = "pre-delete-";

// Backups sit next to the database, so they live on the same volume.
export function backupDirFor(dbPath: string): string {
  return join(dirname(dbPath), "backups");
}

export interface PruneResult {
  ipsCleared: number;
  backupsRemoved: string[];
}

export function pruneRetention(db: Db, backupDir: string, nowS: number): PruneResult {
  const ipsCleared = db
    .prepare(`UPDATE submissions SET ip = NULL WHERE ip IS NOT NULL AND server_ts < ?`)
    .run(nowS - SUBMISSION_IP_DAYS * 86400).changes;

  const backupsRemoved: string[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(backupDir);
  } catch {
    // no backups taken yet
  }

  for (const file of files) {
    if (!file.startsWith(PRE_DELETE_BACKUP_PREFIX)) {
      continue;
    }

    const path = join(backupDir, file);
    if (statSync(path).mtimeMs / 1000 < nowS - PRE_DELETE_BACKUP_DAYS * 86400) {
      unlinkSync(path);
      backupsRemoved.push(file);
    }
  }

  return { ipsCleared, backupsRemoved };
}
