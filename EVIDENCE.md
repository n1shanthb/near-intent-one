  # EVIDENCE — Gate B live run (NEAR testnet)

  **Run time:** 2026-11-09T11:07:14Z → 2026-11-09T11:10:08Z  
  **Network:** `testnet`  
  **MPC signer:** `v1.signer-prod.testnet`  
  **Script:** `scripts/gate-b-live.mjs`  
  **Artifacts:** `evidence/live/*.json`

  ## Manual Ledger confirmation

  **NONE for this Gate B run.**  
  Owner / agent / contract accounts were created via the testnet faucet using software ed25519 keys stored under `.near-credentials/testnet/` (gitignored).

  Ledger is required later only for production high-authority owner ops (`set_policy`, `pause`, `revoke`, `withdraw` / recovery). It was **not** used here and must not be confused with this evidence.

  No mainnet funds were spent.

  ---

  ## Accounts (faucet-created)

  | Role | Account ID | Create tx | Balance after faucet |
  |------|------------|-----------|----------------------|
  | Owner | `nio-owner-02b7cf.testnet` | `GXcbHkrLzgKSDhTyvazt2cubKytNbtdAR53SpQTtTnLC` | `10000000000000000000000000` (10 NEAR) |
  | Agent | `nio-agent-02b7cf.testnet` | `GbGwyQR5Q8H2rk4pS39k51shRUUwigCZxsNtAwUH9YjU` | 10 NEAR |
  | Contract | `nio-policy-02b7cf.testnet` | `Ccci8Qgxuuz2gbqpjFH46eM9nJewUCV86WdkE8FeBUXz` | 10 NEAR |

  Faucet: `https://helper.nearprotocol.com/account`  
  Manifest: `evidence/live/wallets.json`

  ---

  ## 1. Deploy + init

  | Step | Tx hash | Result |
  |------|---------|--------|
  | Deploy wasm (425096 bytes) | `UWD94zL9B7heDxtcpBrPn4GrFksrd3fKTrqfjokpWzP` | Success |
  | `new(owner, agent, mpc_signer, limits)` | `AVUduY81qxZw1k49M9Aa9BFKoHqaLAaiVVfeFjASfS8i` | Success |

  Post-init views:

  - `get_mandate_epoch` = `1`
  - `get_derivation_path` = `trading/v1/1`
  - `get_owner` = `nio-owner-02b7cf.testnet`
  - `get_agent` = `nio-agent-02b7cf.testnet`

  ---

  ## 2. Live MPC root + derived key

  | Item | Value |
  |------|-------|
  | MPC `public_key` (queried live) | `secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3` |
  | Predecessor | `nio-policy-02b7cf.testnet` |
  | Path | `trading/v1/1` |
  | Domain | `0` (secp256k1) |
  | `derived_public_key` | `secp256k1:22JLrNBrtvd4p7YkKhGv5wBL2dCDgvFcRLQ7P3AVsdV3DhfiYTAxc2QVaHXBnDnHD1hN664p8QcugvyUQZAyUv7B` |

  Files: `01-mpc-public-key.json`, `05-derived-public-key.json`

  ---

  ## 3. Propose + request_signature (Gate B core)

  | Step | Tx hash | Result |
  |------|---------|--------|
  | Agent `propose_trade` | `3nFpoFQQn6DZ4YRBBJuDEs5UgfJr9HcDaiTRVMJ7LvnN` | Reserved `op-gateb-1794222482875`, amount `10` |
  | Agent `request_signature` | **`FUUXwoZHw9GcwVpCZYhH8oiB723NrrHr5Eq67HRxP5ss`** | Live MPC Success |

  MPC receipt log (executor `v1.signer-prod.testnet`):

  ```text
  sign: predecessor=AccountId("nio-policy-02b7cf.testnet"), request=SignRequestArgs {
    path: "trading/v1/1",
    payload: Ecdsa(...),
    domain_id: DomainId(0)
  }
  ```

  Policy callback log:

  ```text
  EVENT_JSON:{"event":"signed","operation_id":"op-gateb-1794222482875"}
  ```

  ### Signature (from public receipt SuccessValue — not mocked)

  ```json
  {
    "scheme": "Secp256k1",
    "big_r": {
      "affine_point": "02800e850ae31aaa291d3cc13d640097ae16c56f0a0b051ce57022e4befbd6799f"
    },
    "s": {
      "scalar": "360dcf5d9a77c83748ec503de504acc2bf4fd6714af3a0221ac62585c30c1a2f"
    },
    "recovery_id": 1
  }
  ```

  Payload commitment signed:

  `45ecc908a1a3f9143b42232dabb69f9fe15ec92229abcc2e00925505ebefecd3`

  ### Independent ECDSA verification

  Script: `scripts/verify-ecdsa.mjs` → `evidence/live/19-ecdsa-verify.json`

  - Recovered pubkey matches derived key (**64-byte uncompressed without `0x04`**)
  - `secp256k1.verify` against derived key: **true**
  - **verified: true**

  ---

  ## 4. Revoke + subsequent signing blocked

  | Step | Tx / outcome | Result |
  |------|--------------|--------|
  | Owner `revoke` | `GYhNaTYt5EGqgrnpvcnbB7go9c7qXfL22Tx8A8Lk5odt` (receipt); event epoch→2 | Success |
  | Agent `propose_trade` after revoke | Failure: `WebAssembly trap: unreachable` | **Blocked on-chain** |
  | Agent `request_signature` after revoke | Failure: `WebAssembly trap: unreachable` | **Blocked on-chain** |

  Note: release wasm uses `panic = "abort"`, so `require!("revoked")` surfaces as `unreachable` rather than a UTF-8 panic string. Failure is still an on-chain rejection (tx did not succeed).

  `get_revocation_status` after revoke: `revoked=true`, `mandate_epoch=2`, pending still unresolved → `fully_revoked=false`.

  ---

  ## 5. Pre-revoke signature public extractability

  **Finding: YES — extractable.**

  Even though policy logic gated submission semantics via `on_signature`, the MPC `sign` receipt SuccessValue and the policy callback SuccessValue both publish the full Secp256k1 signature on-chain.

  Observed in:

  - executor `v1.signer-prod.testnet` SuccessValue
  - executor `nio-policy-02b7cf.testnet` SuccessValue / top-level tx SuccessValue

  **Implication:** Revoke cannot cryptographically erase an already-published signature. Correct model:

  1. Immediately forbid new signing (epoch / revoked flag) — **proven**
  2. Quarantine pending exposure until settlement/expiry — **state retained**
  3. Do **not** claim “signature invalidated”

  File: `16-sig-extractability.md.json`

  ---

  ## 6. Path / custody identity (`trading/v1/<epoch>`)

  | | Before revoke | After revoke |
  |--|---------------|--------------|
  | Epoch | `1` | `2` |
  | Path | `trading/v1/1` | `trading/v1/2` |
  | Derived key | `secp256k1:22JLr…Uv7B` | **different path → different custody identity** |

  **Finding:** Embedding `mandate_epoch` in the derivation path **changes custody identity** on every revoke/policy bump. Capital at the old derived address is not moved automatically.

  **Recommendation:**

  1. Prefer a **stable** custody path: `trading/v1/portfolio/<portfolio_id>`
  2. Bind epoch in **payload commitment / nonce**, not in the MPC path
  3. Or use epoch-scoped paths only for ephemeral intent keys that never hold balances
  4. Never accept caller-supplied paths
  5. Document explicit migration if path rotation is ever required

  File: `17-path-custody.json`

  ---

  ## 7. Fabricated agent settlement

  Agent called `mark_settlement(..., Success)` → **on-chain Failure** (`unreachable` / require abort).

  Pending after attempt:

  - `signing_state`: `Signed`
  - `settlement_state`: `None` (unchanged)
  - reserved exposure not released via agent lie

  **Finding:** Agent cannot advance settlement accounting with fabricated status under current ACL (`owner` or `self` only).

  File: `18-fabricated-settlement.json`

  ---

  ## 8. Direct NEAR Intents compatibility (isolated probe) — superseded

  Earlier probe (`20-intents-compat-probe.json`) was **BLOCKED**. Superseded by **Gate C** below.

  ---

  ## Explorer links (Gate B testnet)

  - Contract: https://testnet.nearblocks.io/address/nio-policy-02b7cf.testnet
  - MPC sign tx: https://testnet.nearblocks.io/txns/FUUXwoZHw9GcwVpCZYhH8oiB723NrrHr5Eq67HRxP5ss
  - Propose tx: https://testnet.nearblocks.io/txns/3nFpoFQQn6DZ4YRBBJuDEs5UgfJr9HcDaiTRVMJ7LvnN
  - Deploy tx: https://testnet.nearblocks.io/txns/UWD94zL9B7heDxtcpBrPn4GrFksrd3fKTrqfjokpWzP

  ---

  # EVIDENCE — Gate C live run (Direct Intent Compatibility)

  **Run time:** 2026-11-09T11:31:30Z → 2026-11-09T11:36:04Z  
  **Network:** `testnet`  
  **Verifier:** `verifier.tidepool-sandbox.testnet` (unmodified NEAR Intents / defuse)  
  **MPC signer:** `v1.signer-prod.testnet`  
  **Scripts:** `scripts/gate-c-live.mjs`, `scripts/gate-c-adversarial-onchain.mjs`  
  **Gate B evidence:** preserved (`gate_b_preserved: true`)

  ## Manual Ledger confirmation

  **NONE.** Software faucet keys only. No mainnet funds.

  ## Accounts

  | Role | Account |
  |------|---------|
  | Owner | `nio-c-owner-857107.testnet` |
  | Agent | `nio-c-agent-857107.testnet` |
  | Policy | `nio-c-policy-857107.testnet` |

  ## 1. Stable MPC path

  | | Value |
  |--|-------|
  | Path | `trading/v1/portfolio/gatec1` |
  | After revoke (epoch 2) | `trading/v1/portfolio/gatec1` (unchanged) |
  | Deploy tx | `4m5ScXXULVf7dUHic3SxTikGnT7RgUGUp2SBsUbFJZJc` |
  | Init tx | `9MbdmMzXifDHXdWD9Zh9HAY7R6NMBAFPHu4XmNqy5brz` |

  Epoch remains in authorization state + intent reservation; **not** in the derivation path.

  ## 2. Derived Intents identity

  | | Value |
  |--|-------|
  | Derived NEAR secp key | `secp256k1:2ihLXjLoN6gCvm2rN9odRuqUMJA7EXAs4932XBNnSfo3GeYerhqAZUzZGPMCULWm6prfp5tc3WSp36BZhEQKwW8S` |
  | EVM `signer_id` | `0xcbf7bb47087ec07be2936ce80aaea60e4457fdd4` |
  | `set_intents_signer_id` tx | `E2o6MciKePkx3Ji1PFbih1LSrtXEZsfJx9zGfUTVHxmv` |

  ## 3. Exact ERC-191 payload + EIP-191 digest

  Payload (compact JSON):

  ```json
  {"signer_id":"0xcbf7bb47087ec07be2936ce80aaea60e4457fdd4","verifying_contract":"verifier.tidepool-sandbox.testnet","deadline":"2026-11-09T11:47:35.853Z","nonce":"GDBDsbey2TkATZSL+X9eT5xcvCAnlemEZv7OZm2YOmA=","intents":[{"intent":"transfer","receiver_id":"bob.testnet","tokens":{"nep141:usdc.tidepool-sandbox.testnet":"1"}}]}
  ```

  | Digest | Value |
  |--------|-------|
  | Off-chain EIP-191 | `8adfac51e0042db26efaac7b7f25ff45523cc618f4783f45ddbed6d9a69a8968` |
  | On-chain `eip191_digest` | `8adfac51e0042db26efaac7b7f25ff45523cc618f4783f45ddbed6d9a69a8968` |
  | Match | **true** |

  `propose_intent` tx: `8YEvmzYXHyazuWeib7gboxwinU9jg4dZ55ptLHSSgii4`  
  Contract reserved digest under epoch 1 before MPC.

  ## 4. Live MPC signature → Intents encoding

  | | Value |
  |--|-------|
  | `request_signature` tx | `ERNvoyCZ2Exc4w9dZFsmkipKVYJiz4MyCbwrE1odwZ2w` |
  | MPC path logged | `trading/v1/portfolio/gatec1` |
  | Intents sig | `secp256k1:2FaTnm3gM1NuA6XMcAJFHnEVJV4T1khA7WV4qJ4xeu7ja8p1RPtbgpvf81KFysUnfiinngiRxL7aC1BfmtRtFUZgt` |
  | Recovered address | `0xcbf7bb47087ec07be2936ce80aaea60e4457fdd4` |
  | Matches signer_id | **true** |

  ## 5. Verifier acceptance (on-chain) — authoritative

  Called `execute_intents` on `verifier.tidepool-sandbox.testnet` with the MPC-signed ERC-191 payload.

  Receipt log (signature **accepted**, intent decoded):

  ```text
  EVENT_JSON:{"standard":"dip4","version":"0.4.3","event":"transfer","data":[{
    "intent_hash":"AM75duVL3DqUDUiJPEt1vht6uWoou5C5xwK3smMmdomR",
    "account_id":"0xcbf7bb47087ec07be2936ce80aaea60e4457fdd4",
    "receiver_id":"bob.testnet",
    "tokens":{"nep141:usdc.tidepool-sandbox.testnet":"1"}
  }]}
  ```

  Then execution failed:

  ```text
  Smart contract panicked: insufficient balance or overflow
  ```

  **Classification:** signature verification passed; failure is **balance/execution**, not signature rejection.

  Tx (from node log / retry chain): `DBaDiFaR1PdBzhgw546AW7VEqWBG8zkSVTVsaQTCfh6H`  
  Explorer: https://testnet.nearblocks.io/txns/DBaDiFaR1PdBzhgw546AW7VEqWBG8zkSVTVsaQTCfh6H

  ### Tidepool `/v0/submit-intent` (relay — not authoritative for Gate C)

  HTTP 400: `transfer receiver is not a Tidepool deposit address`  
  This is a Tidepool product filter (expects deposit addresses), **not** a signature verdict. Do not treat as Intents verification.

  Faucet for funding the EVM intents balance is site-only (`https://app.usetidepool.tech/faucet`); API returns 403. Gate C exit criterion is satisfied by on-chain verifier signature acceptance without a funded settle.

  ## 6. Adversarial results

  ### Policy contract (on-chain rejects)

  | Test | Result |
  |------|--------|
  | Wrong signer_id | rejected |
  | Wrong recipient | rejected |
  | Unsupported asset | rejected |
  | Expired deadline | rejected |
  | Post-revocation propose | rejected |
  | Path after revoke | unchanged |

  ### Verifier on-chain (`gate-c-19-adversarial-onchain.json`)

  | Test | Result |
  |------|--------|
  | Tampered payload + original sig | `public key 'secp256k1:52t6…' doesn't exist for account '0xcbf7…'` → **SIGNATURE_REJECTION** |
  | Wrong nonce + original sig | same class → **SIGNATURE_REJECTION** |

  ## 7. Key revocation model (investigation)

  | Model | Verifier key revocation? |
  |-------|---------------------------|
  | ERC-191 implicit EVM (`signer_id` = address) | **No unregister of an intrinsic key.** Auth is recover(payload,sig) ↔ address. Policy revoke stops **new** MPC signatures; published sigs live until deadline/nonce. |
  | Named NEAR + NEP-413 | **Yes** via `add_public_key` / `remove_public_key` on verifier |

  **Do not claim** that ERC-191 implicit accounts support verifier-enforced key deletion.

  ## Gate C reproduction

  ```powershell
  $env:RUSTUP_HOME="E:\toolchains\rustup"
  $env:CARGO_HOME="E:\toolchains\cargo"
  $env:Path="E:\toolchains\nasm;E:\toolchains\cargo\bin;$env:Path"
  cd E:\near-intent-one\contracts\policy
  cargo test
  cargo build --target wasm32-unknown-unknown --release
  cd E:\near-intent-one
  node scripts/gate-c-live.mjs
  node scripts/gate-c-adversarial-onchain.mjs
  ```

## Gate C explorer links

- Policy: https://testnet.nearblocks.io/address/nio-c-policy-857107.testnet
- Deploy: https://testnet.nearblocks.io/txns/4m5ScXXULVf7dUHic3SxTikGnT7RgUGUp2SBsUbFJZJc
- MPC sign: https://testnet.nearblocks.io/txns/ERNvoyCZ2Exc4w9dZFsmkipKVYJiz4MyCbwrE1odwZ2w
- Verifier execute_intents: https://testnet.nearblocks.io/txns/DBaDiFaR1PdBzhgw546AW7VEqWBG8zkSVTVsaQTCfh6H

---

# EVIDENCE — Gate D (Funded MPC-Authorized Swap)

**Run time:** 2026-11-09T12:00Z–12:20Z (settle attempt)  
**Network:** Tidepool NEAR testnet + Ethereum Sepolia (not production 1Click)  
**Script:** `scripts/gate-d-origin-chain.mjs`  
**Target MPC EVM identity:** `0xcbf7bb47087ec07be2936ce80aaea60e4457fdd4`  
**Policy contract:** `nio-c-policy-857107.testnet` (upgraded with `unrevoke`; path `trading/v1/portfolio/gatec1`)  
**Gate B/C:** preserved; no mainnet funds spent. Ledger: NONE (software faucet keys).

## Overall Gate D verdict: PASS

Contract-owned Chain Signature authorized a live Sepolia USDC deposit into a Tidepool `ORIGIN_CHAIN` quote; swap settled `SUCCESS` with intents wNEAR credited to the MPC EVM identity. Post-settle revoke blocked a second propose.

## 1. Funding

| Source | Result |
|--------|--------|
| User Sepolia ETH drip | `0x15cd10e05d1a819a4bc9e3a889105a28ef483f0f81f5092913dbd142f438637b` → **0.05 ETH** on MPC EVM |
| Tidepool UI Ethereum card (Intents mode selected globally; card credits on-chain Sepolia) | **100 USDC + 100 USDT** on Sepolia |
| Tidepool UI Intents drip to same EVM | **429** rate-limited until `2026-11-16T11:51:47Z` (one claim / address / 7 days) |
| API `/v0/faucet` | Still **403 `site_only`** |

Balances before swap: Sepolia USDC **100**; after: **99**. Verifier intents wNEAR after settle: `281057209039548045456000`.

Artifacts: `gate-d-05-funding-sepolia.json`, earlier `gate-d-01/02` blockers retained.

## 2. Mandate reactivation (same custody identity)

Gate C had left the policy **revoked**. Added owner `unrevoke`, upgraded wasm in place (predecessor unchanged → same derived EVM).

| Step | Tx |
|------|-----|
| Deploy upgrade | `3gAXS9voq3TxBCMGRLHYcMCfkjaXiYwLfjvKwaW96bdB` (attempt1) / redeployed on retry |
| `unrevoke` → epoch 6 (retry) | logged `EVENT_JSON:unrevoked` |
| Clear Gate C pending | `mark_settlement(Expired)` |
| `set_policy` allowlist deposit + Sepolia USDC asset | epoch 7 |

Derived EVM after unrevoke still `0xcbf7bb…` (`gate-d-09-derived.json`).

## 3. Live ORIGIN_CHAIN quote (settled)

| Field | Value |
|-------|-------|
| correlationId | `d3165b6b-d018-46eb-a5d4-e1fda9bf511a` |
| originAsset | `nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet` |
| depositType | `ORIGIN_CHAIN` |
| destinationAsset | `nep141:wnear.tidepool-sandbox.testnet` |
| amountIn | `1000000` (1 USDC) |
| amountOut (quote) | `281854815155807356144000` |
| amountOut (settled) | `281057209039548045456000` |
| depositAddress | `0x13290E75c286325Af41de51237c61e7b5610f06A` |
| recipientType | `INTENTS` → `0xcbf7bb…` |

Artifact: `gate-d-10-quote.json`

## 4. Security: deposit-address substitution

`propose_trade` to `0x…0bad` (not allowlisted) → on-chain reject (`unreachable` / require).  
Artifact: `gate-d-12-security-deposit-bind.json` → **PASS**

## 5. Policy-bound MPC sign + Sepolia broadcast

| Step | Result |
|------|--------|
| `propose_trade` `gated-1794226628602` | Reserved; commitment = keccak(EIP-155 unsigned ERC20 transfer) |
| `request_signature` | **`APcU7aqXGAGqpGXNcfzC9h37wLaaEiEZQovGm4xUSXn4`** — live MPC Success |
| ECDSA recover | Matches `0xcbf7bb…` |
| Sepolia ERC20 transfer | **`0x67fde88c4251a2946b7d2ea172b2015a1d4b6dbfdd0b22d84a94a6d8efe75b6e`** receipt **`0x1`**, gasUsed `0x2261e` |

### Attempt 1 (recorded failure — not SUCCESS)

First broadcast `0x9a2bee7d…` mined with **receipt status `0x0`** (OOG at gasLimit 100k). Tidepool briefly showed `KNOWN_DEPOSIT_TX` on a reverted hash. Saved as `gate-d-evidence-attempt1-oog.json`. Retry used estimateGas×1.5 + ≥1 gwei.

## 6. Settlement

Tidepool `/v0/status` → **`SUCCESS`**

| Kind | Hash |
|------|------|
| Origin (Sepolia) | `0x67fde88c4251a2946b7d2ea172b2015a1d4b6dbfdd0b22d84a94a6d8efe75b6e` |
| Intent hashes | `5YCfmBMnqfDLqKGqn82Ge1Ur58J15Ruvvfbo3rwmdJxj`, `9zBDcRd3JkHRDN2fuTCigVBgSFpUzF67ny2WzQv4yHKk` |
| NEAR txs | `EYVySFYiLvqR8dsKPRpkC4mefN39kPnU5AFbAC4bGm9M`, `6S4UCBPCRmm7VU1bJWvfCKFcusH3TtZLTJzuDbrAwDHV`, `HTWeYnNfgTkFCS9RknPSdiLuP12FmLDMj998xcVfKHU4` |

Policy `mark_settlement(Success)` logged for `gated-1794226628602`.  
Artifacts: `gate-d-20-status.json`, `gate-d-21-balances-after.json`

## 7. Revoke race

Owner `revoke` → epoch 8. Subsequent agent `propose_trade` rejected.  
Artifact: `gate-d-22-revoke-race.json` → **PASS**

## Reproduction

```powershell
cd E:\near-intent-one
$env:CARGO_HOME='E:\toolchains\cargo'; $env:RUSTUP_HOME='E:\toolchains\rustup'
# after contract edits:
cd contracts\policy; cargo build --target wasm32-unknown-unknown --release
cd E:\near-intent-one
node scripts/gate-d-origin-chain.mjs
```

---

# EVIDENCE — Gates E1 / E2 / E3 (Security)

**Run time:** 2026-11-09T12:40Z–12:45Z  
**Script:** `scripts/gate-e-security.mjs`  
**Contract:** `nio-c-policy-857107.testnet` (wasm upgrade; path `trading/v1/portfolio/gatec1`)  
**Artifacts:** `gate-e-evidence.json`, `gate-e1-evidence.json`, `gate-e2-evidence.json`, `gate-e3-evidence.json`

## Verdicts

| Gate | Status |
|------|--------|
| E1 Unattended dynamic quote auth | **PASS** (Tidepool direct verify **BLOCKED**) |
| E2 EIP-155 preimage binding | **PASS** |
| E3 Revoke-vs-broadcast race | **PASS** (limitation recorded) |

## E1 — Dynamic quote authorization

Policy `allowed_destinations` = only `bob.testnet` + owner (no quote deposit).

| Check | Result |
|-------|--------|
| `set_trusted_quote_signer` | Trusted `ed25519:HvET2d3y…` |
| Live Tidepool quote deposit | `0x905f341ea16a79261404c08625b16570439e61d7` (not allowlisted) |
| `propose_quoted_evm_transfer` | **Success** — `quoted_evm_reserved` digest `a0a96393…` |
| On-chain digest == off-chain keccak(RLP) | **Match** |
| Expired attestation | Rejected |
| Untrusted signer | Rejected |
| `verifyQuoteSignature` vs 1Click manager key | **false** → Tidepool maker pubkey **BLOCKED** / unpublished |

Attestation message format: `QUOTE_AUTH_V1` lines (see `packages/intents-codec/quote-auth.mjs` ↔ `contracts/policy/src/evm_auth.rs`).

## E2 — Adversarial EIP-155 preimage

| Attack | Result |
|--------|--------|
| Attestation deposit A, `tx.to` = burn | Rejected |
| Attestation amount ≠ `tx.amount` | Rejected |
| Legacy `propose_trade` to `0x…` with agent `payload_commitment` | Rejected (`evm destinations require propose_quoted_evm_transfer`) |

Digest is computed on-chain; agent cannot choose an alternate signing preimage.

## E3 — Sign A → revoke → broadcast A

Harmless transfer: **0.1 Sepolia USDC** to `0x000…dEaD`.

| Step | Hash / result |
|------|----------------|
| Propose A | `6ZZFV21hncpdztYvCxE3Bx7tdeV2XgEiu41A76rf1uZv` |
| MPC sign A | `CUdjGTYsr99sUh47inuiaxwAkwepdoZm9EfWLBNtqoLh` |
| Owner revoke | `8xLvfZy8yMTwSDP4phfdP7DayKT59N1ehTjhgmGG1K7z` (epoch 11, `revoked=true`) |
| Broadcast A | [`0x90d4c64517f0e54082516a84ad0d9cf23a5671ea2e7f8877809615e894367199`](https://sepolia.etherscan.io/tx/0x90d4c64517f0e54082516a84ad0d9cf23a5671ea2e7f8877809615e894367199) |
| Receipt A | **status `0x1`**, gasUsed `0x22546` — **executed after NEAR revoke** |
| Propose B (recheck on fastnear) | Rejected while revoked |

**Limitation:** Already-exported ECDSA signatures remain valid on Sepolia after NEAR revoke. Quote deadlines do not revoke EVM signatures.

## Reproduction

```powershell
cd E:\near-intent-one\contracts\policy
$env:CARGO_HOME='E:\toolchains\cargo'; $env:RUSTUP_HOME='E:\toolchains\rustup'
cargo build --target wasm32-unknown-unknown --release
cd E:\near-intent-one
node scripts/gate-e-security.mjs
```

---

# EVIDENCE — Gate F (Production boundary + hardware + unattended)

**Script:** `scripts/gate-f-security.mjs`  
**Artifacts:** `gate-f-evidence.json`, `gate-f1/f2/f3/f4-evidence.json`  
**Preserved:** Gates B–E (including E3 broadcast-after-revoke limitation)

## Verdicts

| Gate | Status |
|------|--------|
| F1 Trust / signing boundary | **PASS** |
| F2 Revocation recovery | **PASS** |
| F3 Ledger owner proof | **BLOCKED** |
| F4 Unattended trade | **PASS** |

## F1 — Trusted attestor boundary

| Check | Result |
|-------|--------|
| Attestor refuses `requestedDeposit` ≠ quote deposit | **Reject** |
| `QUOTE_AUTH_V2` fields | deposit, amount, assets, min_out, deadline, token, chain_id, recipient, refund_to, correlation_id, quote_hash, max_gas_price, gas_limit |
| On-chain digest == off-chain EIP-155 | **Match** |
| Replay same attestation | **Rejected** |
| `gas_limit` mismatch | **Rejected** |
| Tidepool maker `verifyQuoteSignature` | **BLOCKED** (pubkey unpublished) |

**Claim accuracy:** This is **trusted-attestor authorization**, not independently verified Tidepool maker signatures.

## F2 — Revocation recovery

| Item | Evidence |
|------|----------|
| E3 preserved | Prior A still executed post-revoke (see Gate E) |
| `reconcile_pending` | Requires terminal state + `evidence_hash` (e.g. Sepolia/NEAR tx) |
| Cancel path | Owner-only, `revoked` only, Sepolia, 0-value self-transfer, gas≤100k |
| Cancel broadcast | [`0x7a34a8c751ae60db536b1a80beb7aa009839a34bb8f647067499dc2591f81056`](https://sepolia.etherscan.io/tx/0x7a34a8c751ae60db536b1a80beb7aa009839a34bb8f647067499dc2591f81056) status **`0x1`** |
| Signing vs economic revoke | `get_exposure_snapshot.signing_revoked` vs `economically_settled` |

## F3 — Ledger

| Item | Result |
|------|--------|
| Physical Ledger `set_policy`/`revoke` | **Not performed** (agent env) |
| Owner software FullAccess keys | **1** remaining |
| Prepared path | NEAR Ledger app + LedgerSigner; then remove software FullAccess |
| Seed phrases | Never requested |

## F4 — Unattended trade

Cycle under frozen owner policy (no mid-cycle allowlisting):

1. Agent fetches Tidepool quote  
2. Attestor validates structurally + signs V2  
3. `propose_quoted_evm_transfer` + MPC `request_signature`  
4. Sepolia ERC-20 deposit [`0xe49d5ff80fd8533d9719969b50647e49c99845d79fac27d39578e4003552e558`](https://sepolia.etherscan.io/tx/0xe49d5ff80fd8533d9719969b50647e49c99845d79fac27d39578e4003552e558)  
5. Tidepool status **SUCCESS**  
6. `reconcile_pending(Success, B6uEASppdZmHM25RxiF5U9rs3K98eEkPj77Z8JhGcKfY)`  

NEAR txs: `B6uEASpp…`, `AFXqmLLP…`, `A89wvpNr…`  
Trust model recorded: `trusted_attestor_not_tidepool_maker`

## Reproduction

```powershell
cd E:\near-intent-one\contracts\policy
$env:CARGO_HOME='E:\toolchains\cargo'; $env:RUSTUP_HOME='E:\toolchains\rustup'
cargo build --target wasm32-unknown-unknown --release
cd E:\near-intent-one
node scripts/gate-f-security.mjs
```

---

# EVIDENCE — Gate G (Ledger ownership + accounting)

**Docs:** `GATE_G.md`  
**Artifacts:** `gate-g-evidence.json`, `gate-g-fixup.json`, `gate-g-verify-state.json`  
**Preserved:** F1 attestor trust model; E3 post-revoke EVM execution

## Verdicts

| Check | Status |
|-------|--------|
| Accounting (F2 reserved/unresolved) | **PASS** |
| `reconcile_pending` trust model | **PASS** |
| Narrow reconciler watchdog | **PASS** |
| Ledger physical ownership | **BLOCKED** |
| Gate G overall | **BLOCKED** |

## Accounting

| Item | Evidence |
|------|----------|
| F2 leftover op | `f1-1794229262329` = `Reserved`/`None` (never signed) |
| Classification | Correctly pending until Expired — not fabricated Success |
| Reconcile tx | `9MeJmCE5b1nzcdK6fMMft8vMx6Nx5GizYYWQZDDDzqUE` |
| Final reserved | `0`; `economically_settled: true` |

## Reconcile trust

| Item | Finding |
|------|---------|
| On-chain verification of evidence | **None** (`verified_onchain:false`) |
| Attesting actors | owner or `set_reconciler` account |
| Configured reconciler | `nio-c-agent-857107.testnet` |
| Agent `set_policy` | **Rejected** |

## Ledger

| Item | Result |
|------|--------|
| Hardware txs | **Not performed** |
| Software FullAccess remaining | **1** |
| Prepared flow | `scripts/ledger/01`–`04` (add Ledger key → prove set_policy/revoke → then remove software) |
| Seed phrases | Never requested |

---

# EVIDENCE — Gate H (Hardware + agent backend)

**Docs:** `GATE_H.md`  
**Artifacts:** `gate-h-evidence.json`, `gate-h-decision.json`  
**Script:** `scripts/gate-h.mjs`

## Verdicts

| Check | Status |
|-------|--------|
| H1 Ledger | **PASS** |
| H1 Upgrade authority | **PASS** |
| H2 Reconciler trust | **PASS** |
| H3 Decision loop | **PASS** |
| H4 Repo / API | **PASS** |
| Gate H overall | **PASS** |

## Highlights

| Item | Evidence |
|------|----------|
| Ledger pubkey / path | `ed25519:9omQYtUWotq8AbBhYbfbG7BUbDPjpKRCgeyLQAW48Xjh` · `44'/397'/0'/0'/3'` |
| Hardware `set_policy` | `7SrK8M8eTFBGT6k6VxvaQBTwyMxa5TsdjXUiZkmMX2mb` |
| Hardware `revoke` | `EndhGnPpena59sKXkxEoQqAELmT3mjUfHr9DZpSHqRq9` (`revoked=true`, epoch 19) |
| DELETE_KEY owner/policy software | `cC32MZm8…` / `EQZX8PBq…` |
| Final FA keys | Ledger-only on owner + policy |
| Reconciler | `nio-c-recon-857107.testnet` |
| H3 Sepolia | `0xba28b97b8102dc160db6d89243c67e14538aef1cc0f415f7fbb2f9d903446d09` |
| Interfaces | `packages/agent-api/types.ts`, `API.md` |
| Export | `evidence/live/gate-h1-ledger-export.json` |
