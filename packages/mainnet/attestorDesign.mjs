/**
 * Recommended trusted attestor architecture (J5.1).
 * Do NOT register this key on mainnet yet.
 *
 * On-chain methods (contracts/policy):
 * - set_trusted_quote_signer(public_key)
 * - remove_trusted_quote_signer(public_key)
 * - is_trusted_quote_signer(public_key)
 */

export const ATTESTOR_ARCHITECTURE = Object.freeze({
  role: "trusted_quote_attestor",
  algorithm: "ed25519",
  message_domain: "QUOTE_AUTH_V2",
  on_chain_methods: {
    set: "set_trusted_quote_signer",
    remove: "remove_trusted_quote_signer",
    query: "is_trusted_quote_signer",
  },
  prerequisites: [
    "Official 1Click verifyQuoteSignature PASS on the authentic OneClickQuoteResponse",
    "Pinned official manager key only on mainnet funded paths (no test key override)",
    "Non-dry: depositAddress must be in SDK signed subset (requires SDK >=0.1.26)",
    "Bind quoteRequest to agent request fields",
    "deposit_address taken only from quote.depositAddress (never LLM)",
    "allowUnverifiedOneClick forbidden on mainnet funded paths",
  ],
  key_custody: {
    generate: "nacl.sign.keyPair() offline / HSM — never in git, frontend, or logs",
    storage:
      "encrypted secret store or hardware; packages/services/attestor.mjs seed path gitignored",
    public_material_only_on_chain:
      "ed25519:<base58> via policy set_trusted_quote_signer (owner Ledger)",
    isolation:
      "Attestor key ≠ owner Ledger ≠ agent ops key ≠ MPC derivation seed",
  },
  rotation: {
    steps: [
      "Generate new ed25519 keypair offline",
      "Owner Ledger: set_trusted_quote_signer(new_pk) while old still valid (overlap window)",
      "Cut over attestor service to new seed",
      "Owner Ledger: remove_trusted_quote_signer(old_pk)",
      "Bump mandate_epoch only if compromise suspected (invalidates pending)",
    ],
  },
  revocation: {
    compromise: [
      "remove_trusted_quote_signer(compromised_pk) immediately",
      "optional revoke_signing / pause",
      "rotate to fresh key before any new propose_quoted_evm_transfer",
    ],
    note: "Attestation IDs are single-use on-chain — replay of old attestation is rejected",
  },
  mainnet_status: {
    registered: false,
    do_not_register_until: [
      "Live non-dry quote verifies with pinned manager key AND depositAddress in signed hash",
      "Live min_amount_out passes deployed policy floor (max_slippage_bps) without value inflation",
      "USDC→USDC same-decimal route selected for first tiny trade",
      "Policy unpause + funded_trading gate + broadcast gate explicit owner approval",
      "MPC EVM funded with gas + tiny USDC",
    ],
  },
});

export function attestorDesignSummary() {
  return {
    ...ATTESTOR_ARCHITECTURE,
    generated_at: new Date().toISOString(),
    register_on_mainnet_now: false,
  };
}
