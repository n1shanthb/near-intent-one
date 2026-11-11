# OCI Stability Sprint Report (pre-Ledger)

**Date:** 2026-11-11  
**Instance:** `nio-gate-i-api` · `129.225.72.169` · `VM.Standard.E2.1.Micro` (~498 MiB RAM)  
**Constraint:** Same VM / boot volume / keys / state. No unapproved shape upgrade.

## Evidence (not speculation)

### Confirmed OOM killers (current boot kernel journal)

Repeated **global OOM** events where the killed task was **`dnf`** under `dnf-makecache.service`, anon-RSS ≈ **314–341 MiB** on a **498 MiB** host:

| Time (GMT) | Invoker (oom-killer) | Killed |
|------------|----------------------|--------|
| Nov 10 16:29 | (kernel) | dnf ~314 MiB |
| Nov 10 18:37 | irqbalance | dnf ~337 MiB |
| Nov 10 20:47 | NetworkManager | dnf ~341 MiB |
| Nov 10 23:48 | systemd | dnf ~330 MiB |
| Nov 11 01:33 | sshd | dnf ~340 MiB |
| Nov 11 02:48 | systemd-udevd | dnf ~329 MiB |
| Nov 11 05:25 | pmie | dnf ~328 MiB |

**Conclusion with evidence:** `dnf-makecache` is a **confirmed** recurring OOM driver on this micro. That does **not** by itself prove every historical guest hang was only dnf — prior hangs still fit “RUNNING but SSH/HTTPS dead” after memory thrash — but Node-alone-as-root-cause is **not** claimed.

### Memory / swap / disk (live sample)

- RAM: **498 MiB** total; available often ~250 MiB after stabilize  
- Swap: **~944 MiB** file; **~260–300 MiB used** after thrash window  
- Disk `/`: ample (prior P0 ~22% of 30G)  
- Load: spiked to teens/30s during thrash; decayed toward idle after dnf death  

### Process / service footprint (healthy window)

| Component | Observation |
|-----------|-------------|
| `nio-gate-i` (node) | ~62–78 MiB RSS; `MemoryHigh=280M` `MemoryMax=350M`; `Restart=always` |
| `caddy` | ~45 MiB RSS |
| Reconciler / attestor | In-process under API; health `ok` |
| Settlement worker | **enabled=false**, **dry_run=true**, pending=0 |
| OpenRouter / Gate J | Separate from settlement timer; no overlap on settlement critical path |
| `pmcd` / PCP | Was enabled; **masked/disabled** this sprint (pmie participated in last OOM invoke) |
| `dnf-makecache.timer` | **masked** |

### Watchdog

- Timer active (~2 min). Logs mem + restarts API/Caddy on local health fail.  
- Example: `2026-11-11T03:57:01Z` mem used=401 avail=97 → FAIL local API + caddy → restart.  
- **Limitation:** a fully hung guest OS (TCP SYN without SSH/HTTPS) **cannot** be healed by an in-guest watchdog. External / OCI RESET remains the recovery for that class.

### Health after deploy

- `https://127.0.0.1:8787/v1/health` → ok  
- `https://nio-api-hack26.duckdns.org/v1/health` → ok  
- `owner_auth: nep413`, `allow_sign_env: false`, `settlement_worker.enabled: false`

## Low-risk reversible actions applied

1. Mask `dnf-makecache.timer` (+ service)  
2. Disable/mask PCP (`pmcd`, pmie/pmlogger timers)  
3. Cap `nio-gate-i` cgroup memory (`MemoryHigh` / `MemoryMax`)  
4. Keep API on `127.0.0.1`; Caddy terminates TLS  
5. Pin env: `GATE_K_ALLOW_SIGN=0`, `GATE_K_AUTONOMOUS_LOOP=0`, `GATE_K_SETTLEMENT_WORKER=0`, `GATE_K_SETTLEMENT_DRY_RUN=1`, `GATE_I_SELF_PROVISION=0`  
6. Redeploy api-server + ownerAuth (+ settle modules) without recreating instance  

## Incident note (same sprint)

A remote `awk`/`mv` attempt to dedupe `/etc/nio-gate-i.env` briefly wiped the file to **0 bytes**. Restored immediately from the still-running `api-server` process environ (`/proc/<pid>/environ`) before any further restarts depended on the empty file. Post-restore health **PASS**; safety flags re-pinned OFF.

## Residual risk

E2.1.Micro remains tight for multi-user / LLM + Node + Caddy. Guest hangs may still require **OCI hard RESET**. Shape upgrade stays **operator-approved only**.
