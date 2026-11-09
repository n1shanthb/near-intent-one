# Contract upgrade authority (Gate H1)

Policy contract: `nio-c-policy-857107.testnet`

## Risk

FullAccess on the **contract account** can `DeployContract` (replace WASM) and thereby bypass on-contract policy / request MPC signatures.

## Current mitigation (software)

Owner public key consolidated as the contract FullAccess controller; dedicated contract software key removed when present.

## Ledger completion

1. Complete owner Ledger FullAccess proof (`02`–`04`).
2. Ensure Ledger owner key is FullAccess on **both** owner account and contract account (add-key if needed, signed by current upgrade controller).
3. Remove any remaining software FullAccess from the contract account.
4. Prefer immutable lock only after explicit approval (delete all contract FullAccess — upgrades forever impossible).

Never paste seed phrases.
