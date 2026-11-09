# Add Ledger FullAccess (BEFORE removing software key)

Account: `nio-c-owner-857107.testnet`
Network: NEAR **testnet**

## Steps (local machine with Ledger)

1. Install/open **NEAR** app on Ledger Nano; enable blind signing if required by your tooling.
2. Use one of:
   - `near account add-key nio-c-owner-857107.testnet ... --sign-with-ledger` (near-cli-rs), or
   - `@near-js/client` / `near-api-js` `LedgerSigner` to call `ADD_KEY` with FullAccess.
3. On device: confirm the **public key** matches the Ledger-derived NEAR key you intend.
4. Physically approve the `ADD_KEY` transaction.
5. Re-run `node scripts/ledger/01-print-owner-keys.mjs` — you must see **both**:
   - existing software FullAccess `ed25519:9itHoXewdGq3fK8DYmHwoo32MdP3QdjJpgPPamxTNvvt`
   - new Ledger FullAccess key

**STOP here until both keys are present.** Do not delete software key yet.
