# ScoreServer

Multi-game leaderboard + seasons service. One deployment serves every
game (XLab, Preferans, future bridge): registering a new game is one
CLI command, not a deploy.

## Concepts

- **Game** — a tenant: id, API key (all requests), HMAC secret (score
  submissions), sanity limits, season rotation rule.
- **Board** — a named ladder inside a game (`alltime`, `season:2026-W33`,
  anything). Boards are created implicitly by the first submission.
- **Season** — a first-class time window per game with an opaque JSON
  payload. For a duplicate-bridge game the payload carries the deals
  everyone plays that season; for score-period games it is just a seed.
  The server is the single source of truth for "what season is it".
- **Private payloads** (`--private-payload`): the payload is never
  returned whole. Clients fetch `deal/{index}` one at a time and every
  first access per player is logged (`deal_access`) — the anti-peek
  audit trail for duplicate play.

## API

All routes need `X-Api-Key`. Writes additionally need `X-Ts` (unix
seconds) and `X-Sig` = HMAC-SHA256(secret, `{ts}\n{METHOD}\n{path}\n{sha256hex(body)}`).

```
GET  /health
GET  /v1/{game}/season/current
GET  /v1/{game}/season/current/deal/{index}?player_id=...
POST /v1/{game}/boards/{board}/scores        {player_id, name, score, device_ts?}
GET  /v1/{game}/boards/{board}/top?limit=50
GET  /v1/{game}/boards/{board}/around/{player}?span=5
GET  /v1/{game}/boards/{board}/rank/{player}
```

Boards keep each player's **best** score; ties rank by who got there
first. The shown name is the one from the player's latest accepted
submission, so a rename lands without a new best. Every submission (accepted or rejected) lands in the
`submissions` audit table with IP and timestamps.

Season naming convention for clients: submit season scores to board
`season:{season_id}` using the id from `season/current`; keep `alltime`
as the never-rotating board.

## Honest anti-cheat statement

A client-submitted score can always be forged by a determined attacker
holding the APK (the HMAC secret ships inside it). The layers here —
HMAC signing, per-game score caps, minimum submit intervals, full audit
trail, private deal payloads with access logging — stop casual
tampering and give you the evidence for retro-bans. Do not promise more
than that.

## Operating

```bash
npm ci && npm run build
npm run smoke                      # end-to-end self test
npm run admin -- register-game xlab "XLab" --rotation weekly --max-score 100000 --min-interval 10
npm run admin -- create-season bridge 2026-S1 2026-08-01 2026-11-01 --payload-file deals.json
docker compose up -d --build       # serves 127.0.0.1:8091, db in ./data
```

Put `deploy/nginx-scores.conf` behind your existing TLS (subdomain
recommended). Back up the single `data/scores.db` file.

## Clients

Unity: use the ScoreClientUnity package (separate repo) — a thin
`ScoreClient` over UnityWebRequest with the HMAC signing built in.
