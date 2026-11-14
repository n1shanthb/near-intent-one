#!/usr/bin/env node
/**
 * J17.2 — Owner-gated trusted quote signer registration on j16f6890.testnet.
 * Requires J17_QUOTE_SIGNER_REGISTER_AUTHORIZED=1.
 * HARD STOP default: refuse without auth. This milestone does not execute registration.
 */
import {
  AUTH_QUOTE_SIGNER_REGISTER,
  EXPECTED_ATTESTOR_PK,
  J16_POLICY,
  requireQuoteSignerRegisterAuth,
} from "../../packages/autonomous/j17.sepoliaPath.mjs";

const gate = requireQuoteSignerRegisterAuth();
if (!gate.ok) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        action: "REFUSED",
        reason: gate.reason,
        required_env: `${AUTH_QUOTE_SIGNER_REGISTER}=1`,
        planned_call: {
          contract: J16_POLICY,
          method: "set_trusted_quote_signer",
          args: { public_key: EXPECTED_ATTESTOR_PK },
          actor: "nio-owner-02b7cf.testnet",
        },
        note: "Separate from MPC sign/broadcast authorization. Not executed without explicit owner auth.",
      },
      null,
      2
    )
  );
  process.exit(0);
}

console.log(
  JSON.stringify({
    ok: false,
    action: "AUTH_PRESENT_BUT_J17_2_HARD_STOP",
    reason: "J17.2 forbids executing set_trusted_quote_signer in this milestone even with auth env set",
    note: "Clear auth env for pre-sign check; execute registration only under a later explicit owner run",
  })
);
process.exit(1);
