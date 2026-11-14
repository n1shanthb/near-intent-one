# Codex review — NIO submission

## Tool / version

**UNAVAILABLE.** `codex` CLI was not found on the build machine (`where.exe codex` empty). No Codex screening run was executed.

Per hackathon Q-017, Codex/Claude screen projects for organizers; local absence does not block publishing the repo. This file records the gap honestly.

## Substitute checks performed (agent harness)

| Check | Result |
| --- | --- |
| `pnpm --filter web run build` | PASS |
| `cargo test` (policy) | PASS (56) |
| `pnpm run test:autonomous` | PASS |
| `pnpm run test:mandate` | PASS |
| `pnpm run test:commerce` | PASS |
| `pnpm run test:j16` | PASS |
| Live `/mainnet/mandate` epoch ≥ 3 | PASS (epoch 4) |
| Hosted routes 200 | PASS |
| README claims vs `docs/evidence/*` | Cross-checked in FINAL_VERIFICATION |

## Findings

1. Codex CLI missing — cannot claim Codex PASS.  
2. Historical README (Day 1 / E: toolchain) replaced.  
3. Mandate docs must distinguish epoch 3 activation vs epoch 4 renew — fixed in README / PROOF_INDEX.

## Fixes made

- New judge README, PROOF_INDEX, JUDGE_QUICKSTART, `judge:verify`.  
- Submission pack under `docs/submission/`.

## Unresolved

- Official Codex screening happens post-submit on organizer side.  
- Human X post + form submit still required.
