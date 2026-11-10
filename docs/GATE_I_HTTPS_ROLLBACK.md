# OCI HTTPS / Caddy rollback plan

**Target:** `129.225.72.169` (`nio-gate-i-api`)  
**Do not** change wallet keys, mandates, contracts, or transaction history.

## Pre-change baseline (2026-11-10)

| Item | State |
|------|--------|
| API | `nio-gate-i.service` enabled, Node on **HTTPS self-signed `:8787`** |
| Reconciler | Healthy inside API process (`nio-i-a4e7-recon.testnet`) |
| Data | `/home/opc/near-intent-one/.gate-i-data` (+ TLS cert/key) |
| Env | `/etc/nio-gate-i.env` |
| Host firewall | `firewalld` public: ssh + `8787/tcp` + `8443/tcp` |
| Ports 80/443 | Free |
| Cloudflare quick tunnel | Not running on VM (optional laptop-side) |

## Rollback steps (if HTTPS front breaks)

1. SSH: `ssh -i .gate-i-data/oci-ssh/nio-gate-i-api opc@129.225.72.169`
2. Stop Caddy: `sudo systemctl stop caddy; sudo systemctl disable caddy` (if installed)
3. Confirm API: `curl -sk https://127.0.0.1:8787/v1/health`
4. If API down: `sudo systemctl restart nio-gate-i`
5. Host firewall: keep `8787/tcp` open; remove `80/tcp` `443/tcp` only if needed:
   `sudo firewall-cmd --permanent --remove-port=80/tcp; sudo firewall-cmd --permanent --remove-port=443/tcp; sudo firewall-cmd --reload`
6. Clients fall back to origin: `https://129.225.72.169:8787/v1` (self-signed) or prior tunnel
7. Do **not** reopen broad public access to signing routes without API key

## Non-goals during HTTPS work

- No new trades / Gate K acceptance runs
- No autonomous trading
- No domain purchase
- No Railway/Render/Workers migration
