# OCI P0 Recovery Report

**Date:** 2026-11-10  
**Status:** RESTORED  
**Instance:** `nio-gate-i-api`  
**OCID:** `ocid1.instance.oc1.ap-hyderabad-1.anuhsljrcobqz6icgmd3rjy5uhvnf4axjtihlmtkasieghifj2s3nhfjurda`  
**Region:** `ap-hyderabad-1` (India South / Hyderabad)  
**Shape:** `VM.Standard.E2.1.Micro` (Always Free)

## 1. OCI instance lifecycle state

**RUNNING** (verified via Cloud Shell `oci compute instance get` after hard RESET).

## 2. Current public IP

**`129.225.72.169`** (unchanged).  
DuckDNS `nio-api-hack26.duckdns.org` → `129.225.72.169`.

## 3. Root cause

**Verified sequence:** guest OS hung while the hypervisor still reported RUNNING.

| Stage | Observation |
|-------|-------------|
| Outage start | DNS OK → same IP; TCP SYN to 22/80/443 could succeed, but SSH banner / HTTPS timed out |
| Softreset | Accepted, then stuck in **STOPPING** for a long period |
| Hard RESET | Completed; guest rebooted (~3 min uptime when SSH returned) |
| Services | `caddy` + `nio-gate-i` auto-started (`enabled`); LE cert preserved |

**Primary hypothesis (labeled):** memory pressure / OS hang on Always Free E2.1.Micro (~945 MiB RAM). Post-recovery: ~650 MiB used with low free pages while Node + Caddy + OS share the micro. Fits “RUNNING but unreachable”, softreset stall, and clean recovery after hard RESET with intact boot volume.

**Ruled out:** IP change, DNS drift, terminated instance, LE cert loss, Vercel frontend regression (BFF recovered as soon as OCI HTTPS returned).

## 4. Recovery actions performed

1. Confirmed control-plane state + public IP via OCI Cloud Shell.
2. Softreset was already stuck STOPPING → issued **hard RESET** (`oci compute instance action --action RESET --wait-for-state RUNNING`) — **same boot volume, no recreate**.
3. Waited for guest boot; restored SSH with existing key `.gate-i-data/oci-ssh/nio-gate-i-api`.
4. Verified `caddy` + `nio-gate-i` active; trusted HTTPS and Vercel BFF healthy.
5. Hardened prevention (no data/key changes):
   - `GATE_I_HOST=127.0.0.1` (API no longer public on `:8787`)
   - `Restart=always` on `nio-gate-i` / `caddy`
   - systemd timer `nio-health-watchdog.timer` every 2 minutes (local API + Caddy front health; restarts on fail; logs mem)

**Not done (per constraints):** no instance recreate, no key regen, no trades, no boot-volume detach/replace, no contract changes.

## 5. OCI networking verification

- Public IP unchanged on primary VNIC.
- Ingress still serves **22 / 80 / 443** (required for SSH + ACME + HTTPS).
- Post-harden: **8787 listens only on `127.0.0.1`** (Caddy terminates public TLS → loopback Node).
- DuckDNS hostname unchanged.

## 6. SSH access status

**PASS** — `opc@129.225.72.169` with existing key after RESET.

## 7. Caddy / API / reconciler health

| Component | Status |
|-----------|--------|
| `caddy.service` | active + enabled |
| `nio-gate-i.service` | active + enabled; TLS on `127.0.0.1:8787` |
| Reconciler (in-process) | `ok` — `nio-i-a4e7-recon.testnet` |
| Attestor | `ok` — same public key as pre-outage |
| Disk | 22% used on `/` (30G) |
| Swap | present (~944 MiB), unused at check |

## 8. Public trusted HTTPS

**PASS**

```
GET https://nio-api-hack26.duckdns.org/v1/health → 200
```

- Cert: `CN=nio-api-hack26.duckdns.org`
- Issuer: Let's Encrypt (`YE2`)
- No insecure TLS bypass required

## 9. Vercel BFF health

**PASS**

```
GET https://near-intent-one.vercel.app/api/v1/health → 200
GET https://near-intent-one.vercel.app/api/v1/gate-j/demo-status → 200
```

Judge path restored (BFF → OCI trusted HTTPS).

## 10. Gate J demo readiness

**PASS / ready**

- `demo-status`: `enabled=true`, `kill_switch=false`
- Portfolio fixed: `i-a-a4e7`
- Limits intact: client 3/day, global 40/day, **max_spend_usd=$2**, min interval 15s, single-flight TTL 180s
- Usage preserved across reboot: `global_calls=4`, `spend_usd≈0.13865`
- Gate K: `allow_sign_env=false`, `autonomous_loop_env=false`
- Env: `GATE_K_ALLOW_SIGN=0`, `GATE_K_ACCEPTANCE=0`, `GATE_K_AUTONOMOUS_LOOP=0`

## 11. Persistence and monitoring improvements

| Item | Result |
|------|--------|
| Boot volume | preserved (RESET, not terminate/recreate) |
| `.gate-i-data/state.json` | present (~11 KB) after reboot |
| Demo quota / spend | preserved (usage counters intact) |
| LE cert storage | reused by Caddy (no re-issue required for recovery) |
| Autostart | `caddy` + `nio-gate-i` enabled |
| Watchdog | `nio-health-watchdog.timer` every 2 min |
| Public API bind | localhost-only |

## 12. Data / keys / evidence

**Confirmed preserved.** Same instance, same boot volume, same SSH key, same attestor public key, same DuckDNS hostname, demo spend counters retained. No credential regeneration.

## 13. No new trades

**Confirmed.** Recovery used only control-plane RESET + read-only health/status checks + service restart/hardening. No Gate K execute, no signing, no withdrawals, no funded decide path.

---

### Judge URLs (post-recovery)

- API: `https://nio-api-hack26.duckdns.org/v1`
- SPA / BFF: `https://near-intent-one.vercel.app`
