# Remove software FullAccess (ONLY after Ledger proofs)

Prerequisites (all required):

- [ ] Ledger FullAccess key present on `nio-c-owner-857107.testnet`
- [ ] Ledger-signed `set_policy` tx hash recorded
- [ ] Ledger-signed `revoke` tx hash recorded
- [ ] Post-revoke view shows revoked=true
- [ ] You can still sign a follow-up `unrevoke` or `pause` with Ledger

Then delete software key:

`ed25519:9itHoXewdGq3fK8DYmHwoo32MdP3QdjJpgPPamxTNvvt`

via `DELETE_KEY` signed by **Ledger**.

Re-run `01-print-owner-keys.mjs` — software FullAccess must be gone; Ledger FullAccess remains.

If Ledger signing fails at any point **before** delete, keep the software key.
