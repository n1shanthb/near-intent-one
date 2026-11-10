# Gate I / Gate J API — OCI Always Free VM

## Instance

| Field | Value |
|-------|-------|
| Name | `nio-gate-i-api` |
| Region | `ap-hyderabad-1` (India South) |
| Shape | `VM.Standard.E2.1.Micro` (Always Free, ~500 MiB RAM) |
| Image | Oracle Linux 9 |
| Public IP | `129.225.72.169` (verify with OCI console — do not assume forever) |
| SSH user | `opc` |
| SSH private key (local) | `.gate-i-data/oci-ssh/nio-gate-i-api` (gitignored) |
| systemd | `nio-gate-i.service` |
| Env file | `/etc/nio-gate-i.env` (gitignored on host; never commit) |

## Public HTTPS URL

| Endpoint | URL |
|----------|-----|
| Trusted (Cloudflare quick tunnel — ephemeral) | `https://consider-deserve-findarticles-carol.trycloudflare.com/v1` |
| OCI origin (self-signed) | `https://129.225.72.169:8787/v1` |
| Gate I health | `…/health` |
| Gate J health | `…/gate-j/health` |
| Decide (auth) | `POST …/gate-j/decide` |

Origin TLS is **HTTPS-only on 8787** (self-signed under `.gate-i-data/tls/`). For browser-trusted access without `-k`, front with Cloudflare Tunnel (quick URL above is temporary; use a **named tunnel** + custom hostname for stability).

Mutations and Gate J LLM/decide require server-side `X-Api-Key` (`.gate-i-data/oci-api-key.txt`). Do **not** embed OpenRouter or signing secrets in Vite.

```bash
ssh -i .gate-i-data/oci-ssh/nio-gate-i-api opc@129.225.72.169
curl -sS https://consider-deserve-findarticles-carol.trycloudflare.com/v1/health
curl -sk https://129.225.72.169:8787/v1/gate-j/health
```

## OpenRouter (server-side only)

Set in `/etc/nio-gate-i.env` (not Vite):

```bash
GATE_J_LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=...
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
GATE_J_RESEARCH_MODEL=google/gemini-2.5-flash
GATE_J_STRATEGIST_MODEL=anthropic/claude-sonnet-4.6
GATE_J_CRITIC_MODEL=openai/gpt-5.2
```

## Deploy notes

`VM.Standard.E2.1.Micro` OOMs easily. Prefer Node binary tarball over `dnf install nodejs`. Upload code tarball + `systemctl restart nio-gate-i`.

If SSH/API become unreachable: check OCI console for **STOPPED** vs **RUNNING**, VCN security list TCP **22** + **8787**, and host OOM / `journalctl -u nio-gate-i`.

**Do not recreate the instance** without confirming the intended deployment target and updating this doc with the new OCID/IP.

## Secrets boundary

Do **not** put Ledger / owner FullAccess keys, attestor seed, or OpenRouter keys in git or the browser. Attestor seed and TLS material live under `GATE_I_DATA_DIR` on the VM.
