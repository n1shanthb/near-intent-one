# Vercel production deploy — NIO judge demo

## Architecture

```
Browser → https://*.vercel.app
       → /api/v1/*  (Vercel Serverless BFF)
       → NIO_API_BASE (trusted OCI HTTPS /v1)
```

## Hobby plan note

Vercel **Hobby** is for personal/non-commercial use. Prize-bearing hackathon demos are commonly hosted on Hobby as personal projects, but if Vercel terms or the prize sponsor require commercial-capable hosting, upgrade to **Pro** before claiming production commercial use. Do not silently assume commercial rights on Hobby.

## Required Vercel env (server)

| Name | Value |
|------|--------|
| `NIO_API_BASE` | `https://<Chat1-duckdns-or-caddy>/v1` — **trusted TLS only** |
| `GATE_I_API_KEY` | Shared with OCI (never `VITE_*`) |
| `NIO_PUBLIC_LIVE_AI` | `true` only after rate limits + TLS verified |

## Public Vite env

See `.env.production.example`. Defaults: `VITE_GATE_I_API_BASE=/api/v1`, `VITE_PUBLIC_LIVE_AI=false`.

## Root directory

Deploy from `apps/web` (install/build/output: npm / `dist` / vercel.json).

## BFF routing note

Non-Next.js Vercel projects do **not** support multi-segment catch-alls (`api/[...path].ts` only matches one segment). Use `api/index.ts` plus rewrite `"/api/(.*)" → "/api"` so `/api/v1/gate-j/*` reaches the BFF.

## Production upstream

`NIO_API_BASE=https://nio-api-hack26.duckdns.org/v1` + `GATE_I_API_KEY` (from `.gate-i-data/oci-api-key.txt`, never `VITE_*`). Keep `NIO_PUBLIC_LIVE_AI=false` until shared rate limits are confirmed.
