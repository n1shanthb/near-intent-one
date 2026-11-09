# near-intent-one — product UI

Judge-facing autonomous trading control center.

**Your hardware wallet sets the rules. Your AI trades across chains. NEAR enforces the boundaries.**

Tracks: `defi` · `security` · `agents`

## Run locally

```powershell
cd E:\near-intent-one\apps\web
npm install
npm run dev
```

- App: http://127.0.0.1:5173  
- Ledger wizard: http://127.0.0.1:5173/setup/ledger  

`/api/ledger-migrate` exists **only** on the Vite dev server (localhost). It is **not** part of the static production build and never ships private keys to the browser.

## Build / test

```powershell
npm test
npm run build
npm run preview
```

## Deploy (static)

Deploy `apps/web/dist` to Vercel/Netlify/Cloudflare Pages.

```powershell
npm run build
# deploy dist/
```

Configure SPA fallback (`vercel.json` included). Do **not** enable any migration API in production.

Optional env:

- `VITE_POLICY_CONTRACT_ID`
- `VITE_OWNER_ACCOUNT_ID`
- `VITE_AGENT_ACCOUNT_ID`

## Entry paths

| Path | Behavior |
|------|----------|
| Connect Ledger | Existing wizard · ownership VERIFIED historically · device may be DISCONNECTED |
| Connect NEAR Wallet | Read-only · no claim of demo-contract ownership |
| Explore Demo | No wallet · recorded F4/H3/H1 proofs |

## Evidence highlights

| Item | Proof |
|------|--------|
| H1 Ledger set_policy | `7SrK8M8eTFBGT6k6VxvaQBTwyMxa5TsdjXUiZkmMX2mb` |
| H1 Ledger revoke | `EndhGnPpena59sKXkxEoQqAELmT3mjUfHr9DZpSHqRq9` (epoch 19 revoked) |
| H3 Sepolia | `0xba28b97b8102dc160db6d89243c67e14538aef1cc0f415f7fbb2f9d903446d09` |
| H3 MPC | `CGbXc3cHHv1jWGeaK4Xj2mAqE29NQ2UhmrgaUr9udKPC` |
| F4 Sepolia | `0xe49d5ff80fd8533d9719969b50647e49c99845d79fac27d39578e4003552e558` |

Mandate is **revoked** after H1 proof. Do not auto-unrevoke or run funded trades from this UI.

## Video recording plan (≈90s)

1. Judge demo landing + three entry cards  
2. H3 decision + Sepolia/MPC links  
3. Security: Ledger VERIFIED + E3 limitation  
4. Brief Ledger wizard screen (device optional)  
5. Predict labeled ILLUSTRATIVE  

## Unsupported (honest)

- Per-user policy deploy from a random wallet  
- LLM Copilot (typed Policy Compiler only)  
- Live mainnet trading  
- On-chain verification of `evidence_hash`  
- Auto-unrevoke / auto-funded trades  
