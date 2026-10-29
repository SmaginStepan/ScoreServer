import type { Db, Game } from "./db.js";
import { verifyAppleTransaction } from "./stores/apple.js";
import { StoreUnavailable, type GoogleVerifier } from "./stores/google.js";

// In-app purchases are checked here before a game grants what was bought:
// the store must confirm a completed purchase of that product in the
// game's own app, and each store transaction is granted once, to the
// player who first showed it. That player may ask again (a grant lost
// before the game saved it); anyone else replaying it is refused.

export interface PurchaseChecks {
  google?: GoogleVerifier;
  appleRootFingerprint?: string;
}

export interface PurchaseClaim {
  player_id: string;
  store: "google" | "apple";
  product_id: string;
  // Google: the purchase token. Apple: the signed transaction (JWS).
  token: string;
}

export type PurchaseResult =
  | { valid: true; product_id: string; transaction_id: string; repeat: boolean }
  | { valid: false; reason: string };

export async function checkPurchase(
  db: Db,
  game: Game,
  claim: PurchaseClaim,
  checks: PurchaseChecks,
  nowS: number,
): Promise<PurchaseResult> {
  const app = db
    .prepare(`SELECT app_id FROM game_stores WHERE game_id = ? AND store = ?`)
    .get(game.id, claim.store) as { app_id: string } | undefined;
  if (!app) {
    return invalid(`no ${claim.store} app registered for ${game.id}`);
  }

  let transactionId: string;
  let environment: string | null;
  if (claim.store === "apple") {
    const check = verifyAppleTransaction(claim.token, checks.appleRootFingerprint);
    if (!check.valid) {
      return check;
    }

    const transaction = check.transaction;
    if (transaction.bundleId !== app.app_id) {
      return invalid("a purchase in another app");
    }

    if (transaction.productId !== claim.product_id) {
      return invalid("a purchase of another product");
    }

    if (transaction.revocationDate) {
      return invalid("refunded");
    }

    transactionId = transaction.transactionId;
    environment = transaction.environment ?? null;
  } else {
    if (!checks.google) {
      throw new StoreUnavailable("google purchase checks are not configured");
    }

    const check = await checks.google(app.app_id, claim.product_id, claim.token);
    if (!check.valid) {
      return check;
    }

    transactionId = claim.token;
    environment = check.test ? "Test" : "Production";
  }

  const granted = db
    .prepare(`SELECT player_id, product_id FROM purchases WHERE store = ? AND transaction_id = ?`)
    .get(claim.store, transactionId) as { player_id: string; product_id: string } | undefined;
  if (granted) {
    return granted.player_id === claim.player_id && granted.product_id === claim.product_id
      ? { valid: true, product_id: claim.product_id, transaction_id: transactionId, repeat: true }
      : invalid("already granted to another player");
  }

  db.prepare(
    `INSERT INTO purchases (store, transaction_id, game_id, player_id, product_id, environment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(claim.store, transactionId, game.id, claim.player_id, claim.product_id, environment, nowS);
  return { valid: true, product_id: claim.product_id, transaction_id: transactionId, repeat: false };
}

function invalid(reason: string): PurchaseResult {
  return { valid: false, reason };
}
