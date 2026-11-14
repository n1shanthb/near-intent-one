# J17.2 — NIO_TX_JOURNAL_SECRET provisioning

Financial execution requires a securely configured durable journal secret.

## Rules

1. **Provision once** under owner control — never during crash recovery.
2. **Never print** the secret to logs, evidence JSON, commits, or chat.
3. **Never regenerate** if the process restarts mid-flight; missing secret ⇒ fail closed.
4. **Never commit** secrets (`.nio-secure/` and `.env*` are gitignored).

## Option A — Environment variable

```powershell
# Generate offline (do not paste into tickets/chat):
# openssl rand -base64 48
$env:NIO_TX_JOURNAL_SECRET = "<≥32 char secret>"
```

## Option B — Durable file

Path: `.nio-secure/j17/journal.secret` (mode 0600 on Unix).

```powershell
New-Item -ItemType Directory -Force -Path .nio-secure\j17 | Out-Null
# Write secret once; do not re-run on recovery:
# Set-Content -Path .nio-secure\j17\journal.secret -Value (openssl ...) -NoNewline
```

Or: `node scripts/j17/provision-journal-secret.mjs` (explicit provision only; refuses if file already exists).

## Crash recovery

If `NIO_TX_JOURNAL_SECRET` / file is missing after a crash:

- **Do not** generate a new secret.
- Restore the original secret from the secure store.
- Resume via persisted pre-sign intent / journal rows for the existing operation_id.
