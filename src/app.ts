import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { Db, Game } from "./db.js";
import { verify } from "./hmac.js";
import { checkPurchase, type PurchaseChecks } from "./purchases.js";
import { currentSeason, dealForIndex } from "./seasons.js";
import { submitScore, top, around, rankOf } from "./scores.js";

const submitBody = z.object({
  player_id: z.string().min(1).max(64),
  name: z.string().min(1).max(32),
  score: z.number().int(),
  device_ts: z.number().int().optional(),
});

const purchaseBody = z.object({
  player_id: z.string().min(1).max(64),
  store: z.enum(["google", "apple"]),
  product_id: z.string().min(1).max(64),
  token: z.string().min(1).max(16384),
});

interface GameRequest extends Request {
  game?: Game;
  rawBody?: Buffer;
}

export interface AppOptions {
  purchases?: PurchaseChecks;
}

// Exported separately from the listener so the smoke test can drive
// the app in-process against a temp database.
export function createApp(db: Db, options: AppOptions = {}) {
  const app = express();
  app.set("trust proxy", true);
  app.use(
    express.json({
      limit: "64kb",
      // Keep the raw bytes: HMAC signatures cover the body verbatim.
      verify: (req, _res, buf) => {
        (req as GameRequest).rawBody = buf;
      },
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Every game route authenticates with the game's API key. Reads stop
  // here; writes additionally verify the HMAC signature below.
  const gameAuth = (req: GameRequest, res: Response, next: NextFunction) => {
    const game = db
      .prepare(`SELECT * FROM games WHERE id = ?`)
      .get(req.params.game) as Game | undefined;

    if (!game || req.header("X-Api-Key") !== game.api_key) {
      res.status(401).json({ error: "unknown game or bad api key" });
      return;
    }

    req.game = game;
    next();
  };

  const signedWrite = (req: GameRequest, res: Response, next: NextFunction) => {
    const result = verify(
      req.game!.hmac_secret,
      req.header("X-Ts") ?? "",
      req.method,
      req.path,
      req.rawBody ?? Buffer.alloc(0),
      req.header("X-Sig") ?? "",
      Math.floor(Date.now() / 1000),
    );

    if (!result.ok) {
      res.status(401).json({ error: result.reason });
      return;
    }

    next();
  };

  app.get("/v1/:game/season/current", gameAuth, (req: GameRequest, res) => {
    const nowS = Math.floor(Date.now() / 1000);
    const season = currentSeason(db, req.game!, nowS);
    if (!season) {
      res.status(404).json({ error: "no current season" });
      return;
    }

    res.json({
      season_id: season.season_id,
      starts_at: season.starts_at,
      ends_at: season.ends_at,
      // Private payloads are never shipped whole; use the deal
      // endpoint (which logs access) instead.
      payload: req.game!.payload_private ? null : season.payload,
    });
  });

  app.get(
    "/v1/:game/season/current/deal/:index",
    gameAuth,
    (req: GameRequest, res) => {
      const playerId = String(req.query.player_id ?? "");
      if (!playerId) {
        res.status(400).json({ error: "player_id query parameter required" });
        return;
      }

      const nowS = Math.floor(Date.now() / 1000);
      const season = currentSeason(db, req.game!, nowS);
      if (!season) {
        res.status(404).json({ error: "no current season" });
        return;
      }

      const result = dealForIndex(
        db,
        req.game!,
        season,
        Number(req.params.index),
        playerId,
        nowS,
      );

      if ("error" in result) {
        res.status(400).json(result);
        return;
      }

      res.json({ season_id: season.season_id, index: Number(req.params.index), deal: result.deal });
    },
  );

  app.post(
    "/v1/:game/boards/:board/scores",
    gameAuth,
    signedWrite,
    (req: GameRequest, res) => {
      const parsed = submitBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "bad body" });
        return;
      }

      const result = submitScore(
        db,
        req.game!,
        String(req.params.board),
        parsed.data.player_id,
        parsed.data.name,
        parsed.data.score,
        parsed.data.device_ts,
        req.ip,
        Math.floor(Date.now() / 1000),
      );

      res.json(result);
    },
  );

  // A store purchase to check before the game grants it. A refused one
  // answers valid: false; 503 means the store could not be asked, and
  // the game keeps the purchase unfinished to ask again later.
  app.post(
    "/v1/:game/purchases",
    gameAuth,
    signedWrite,
    async (req: GameRequest, res) => {
      const parsed = purchaseBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "bad body" });
        return;
      }

      const claim = parsed.data;
      try {
        const result = await checkPurchase(
          db, req.game!, claim, options.purchases ?? {}, Math.floor(Date.now() / 1000));
        if (!result.valid) {
          console.warn(
            `purchase refused: ${req.game!.id} ${claim.store} ${claim.product_id} player ${claim.player_id}: ${result.reason}`);
        }

        res.json(result);
      } catch (error) {
        console.error(`purchase check failed: ${req.game!.id} ${claim.store} ${claim.product_id}: ${error}`);
        res.status(503).json({ error: "store unavailable, try again later" });
      }
    },
  );

  app.get("/v1/:game/boards/:board/top", gameAuth, (req: GameRequest, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    res.json({ entries: top(db, req.game!.id, String(req.params.board), limit) });
  });

  app.get(
    "/v1/:game/boards/:board/around/:player",
    gameAuth,
    (req: GameRequest, res) => {
      const span = Math.min(Math.max(Number(req.query.span ?? 5), 1), 50);
      res.json({
        entries: around(
          db, req.game!.id, String(req.params.board), String(req.params.player), span),
      });
    },
  );

  app.get(
    "/v1/:game/boards/:board/rank/:player",
    gameAuth,
    (req: GameRequest, res) => {
      res.json({
        rank: rankOf(db, req.game!.id, String(req.params.board), String(req.params.player)),
      });
    },
  );

  return app;
}
