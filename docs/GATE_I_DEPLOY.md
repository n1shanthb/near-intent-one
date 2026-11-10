# Gate I API — deployable hosted service

## Health

`GET /v1/health` → `{ ok: true, network: "testnet", services: { agent, attestor, reconciler } }`

## Auth model

| Route class | Auth |
|-------------|------|
| `GET /v1/health` | Public |
| Other `GET` | Public if `GATE_I_API_KEY` unset (dev); otherwise optional |
| `POST` mutations | Requires `X-Api-Key: $GATE_I_API_KEY` or `Authorization: Bearer …` when key set |

Owner **wallet/Ledger** signs `set_policy` / withdraw on-chain. The API never returns private keys, attestor seeds, or FullAccess material. `GATE_I_ALLOW_SERVER_OWNER_SIGN` must stay `0` in production.

## CORS

`GATE_I_CORS_ORIGINS` — comma list of web origins (e.g. your Vercel web URL). Use `*` only for local demos.

## Persistence / restart

File store under `GATE_I_DATA_DIR` (default `.gate-i-data/`):

- `state.json` — portfolios, decisions, executions, nonces
- `attestor.seed.json` — server-only
- `last-boot.json` — recovery metadata

On boot, in-flight executions are listed via `recoverPending()` (idempotent keys). Use a **persistent volume** (Railway/Fly/Render disk). Ephemeral serverless FS alone is insufficient.

## Local

```bash
cp packages/services/.env.example packages/services/.env
node packages/services/api-server.mjs
curl -s http://127.0.0.1:8787/v1/health
```

Web: `VITE_GATE_I_API_BASE=http://127.0.0.1:8787/v1`

## Docker

```bash
docker build -f packages/services/Dockerfile -t nio-gate-i-api .
docker run --rm -p 8787:8787 \
  -e GATE_I_API_KEY=… \
  -e GATE_I_CORS_ORIGINS=https://your-app.vercel.app \
  -v "$PWD/.near-credentials:/app/.near-credentials:ro" \
  -v gatei:/app/.gate-i-data \
  nio-gate-i-api
```

## Platform checklist (Railway / Fly / Render)

1. Deploy Docker image or `node packages/services/api-server.mjs`
2. Attach persistent volume → `GATE_I_DATA_DIR`
3. Mount/upload `.near-credentials/testnet` for **agent + reconciler only** (not Ledger demo keys)
4. Set `GATE_I_API_KEY`, `GATE_I_CORS_ORIGINS`, `NEAR_NETWORK=testnet`
5. Confirm `GET https://<host>/v1/health`
6. Point web `VITE_GATE_I_API_BASE=https://<host>/v1`

## Secrets boundary

| Secret | Location | Browser? |
|--------|----------|----------|
| Attestor ed25519 seed | `GATE_I_DATA_DIR` | **No** |
| Agent / reconciler NEAR keys | `.near-credentials` on server | **No** |
| Owner / Ledger keys | User device only | Signed txs only |
| `GATE_I_API_KEY` | Server + CI | Web may hold **public** API key for mutations if you accept that threat model; prefer server-side BFF |

Demo `nio-c-*` Ledger keys are never loaded by this service.
