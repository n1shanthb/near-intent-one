#![allow(clippy::too_many_arguments)]

mod evm_auth;

use near_sdk::json_types::{U128, U64};
use near_sdk::store::IterableMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

/// Official guidance: attach ≥ 15 Tgas to the MPC `sign` receipt.
const SIGN_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(15);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// secp256k1 domain on current NEAR MPC deployments.
const DOMAIN_SECP256K1: u64 = 0;

/// Contract-owned derivation prefix. Never accept a full caller-supplied path.
/// Path is STABLE across epochs: trading/v1/portfolio/<portfolio_id>
const PATH_PREFIX: &str = "trading/v1/portfolio";

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Payload {
    /// 32-byte hash as lowercase hex (64 chars).
    Ecdsa(String),
    Eddsa(String),
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Scalar {
    pub scalar: String,
}

#[near(serializers = [json])]
#[serde(tag = "scheme")]
#[derive(Clone, Debug)]
pub enum SignatureResponse {
    Secp256k1 {
        big_r: AffinePoint,
        s: Scalar,
        recovery_id: u8,
    },
    Ed25519 {
        signature: Vec<u8>,
    },
}

#[ext_contract(ext_mpc)]
pub trait MpcSigner {
    fn sign(&mut self, request: SignRequest);
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SigningState {
    Reserved,
    Signing,
    Signed,
    RolledBack,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SettlementState {
    None,
    Submitted,
    Processing,
    Success,
    Refunded,
    Failed,
    Expired,
    Reconciled,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct PolicyLimits {
    pub max_trade_value: U128,
    pub daily_turnover_limit: U128,
    pub max_pending_exposure: U128,
    pub max_slippage_bps: u32,
    /// Canonical asset ids only (eip155:<id>:0x… / nep141:… / native:…). Never symbols alone.
    pub allowed_assets: Vec<String>,
    pub allowed_destinations: Vec<String>,
    pub valid_until: U64,
    /// "allowlist" (default) | "any_eligible_token" — broad mode must be explicit.
    pub token_scope: String,
    /// CAIP-2 style: "near", "eip155:1", "eip155:42161", "eip155:8453"
    pub allowed_chains: Vec<String>,
    /// Execution venues: near_intents_1click | evm_0x | near_native_dex
    pub allowed_venues: Vec<String>,
    /// Soft gas budget (wei or yocto depending on venue); enforced as upper bound on attested gas*price where applicable.
    pub max_gas_budget: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct TradeProposal {
    pub operation_id: String,
    pub amount_in: U128,
    pub asset_in: String,
    pub asset_out: String,
    pub destination: String,
    pub min_amount_out: U128,
    pub intent_deadline: U64,
    /// 32-byte keccak/sha256 commitment hex built by the contract path (agent supplies semantic fields only).
    pub payload_commitment: String,
}

/// Owner-configured quote attestation (Gate F1). Signed by a trusted ed25519 key.
/// Binds deposit, economics, recipient/refund, quote identity, and gas bounds.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct QuoteAttestation {
    pub deposit_address: String,
    pub amount_in: U128,
    pub asset_in: String,
    pub asset_out: String,
    pub min_amount_out: U128,
    pub quote_deadline_ns: U64,
    pub token_contract: String,
    pub chain_id: U64,
    pub recipient: String,
    pub refund_to: String,
    pub correlation_id: String,
    pub quote_hash: String,
    pub max_gas_price: U128,
    pub gas_limit: U64,
}

/// EIP-155 legacy tx parameters. Digest is computed on-chain (Gate E2/F1).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct EvmTxParams {
    pub nonce: U64,
    pub gas_price: U128,
    pub gas_limit: U64,
    pub chain_id: U64,
    pub token_contract: String,
    pub to: String,
    pub amount: U128,
}

/// Narrow post-revoke cancel: replace nonce with 0-value self-transfer (Gate F2).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct EvmCancelParams {
    pub nonce: U64,
    pub gas_price: U128,
    pub gas_limit: U64,
    pub chain_id: U64,
}

/// Gate I2: owner recovery/withdrawal ERC-20 transfer. Works while paused or revoked.
/// Does not grant the agent any signing path.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct EvmWithdrawParams {
    pub nonce: U64,
    pub gas_price: U128,
    pub gas_limit: U64,
    pub chain_id: U64,
    pub token_contract: String,
    pub to: String,
    pub amount: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ExposureSnapshot {
    pub reserved_pending_exposure: U128,
    pub realized_exposure: U128,
    pub revoked: bool,
    pub mandate_epoch: u64,
    pub unresolved_pending: u64,
    pub signing_revoked: bool,
    pub economically_settled: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PendingOpSummary {
    pub operation_id: String,
    pub epoch: u64,
    pub amount_in: U128,
    pub destination: String,
    pub signing_state: SigningState,
    pub settlement_state: SettlementState,
    pub payload_commitment: String,
    pub intent_payload: String,
    pub evidence_hash: Option<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct PendingOp {
    pub epoch: u64,
    pub amount_in: U128,
    pub asset_in: String,
    pub asset_out: String,
    pub destination: String,
    pub min_amount_out: U128,
    pub requested_at: u64,
    pub intent_deadline: u64, // stored as raw ns; set from U64 proposal field
    /// EIP-191 digest hex (intent path) or opaque commitment (legacy trade path).
    pub payload_commitment: String,
    /// Exact ERC-191 payload bytes (empty for legacy trade proposals).
    pub intent_payload: String,
    pub signing_state: SigningState,
    pub settlement_state: SettlementState,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RevocationStatus {
    pub revoked: bool,
    pub mandate_epoch: u64,
    pub active_signing_requests: u64,
    pub unresolved_pending: u64,
    pub fully_revoked: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PolicyContract {
    pub owner: AccountId,
    pub agent: AccountId,
    pub mpc_signer: AccountId,
    /// Stable custody namespace — never changes with mandate_epoch.
    pub portfolio_id: String,
    /// Lowercase 0x-prefixed EVM address recovered from contract-derived MPC key.
    pub intents_signer_id: String,
    /// e.g. verifier.tidepool-sandbox.testnet
    pub verifying_contract: String,
    pub mandate_epoch: u64,
    pub paused: bool,
    pub revoked: bool,
    pub strategy_hash: String,
    pub policy_hash: String,
    pub limits: PolicyLimits,
    pub next_operation_nonce: u64,
    pub pending: IterableMap<String, PendingOp>,
    pub reserved_pending_exposure: u128,
    pub realized_exposure: u128,
    pub daily_turnover: u128,
    pub daily_turnover_day: u64,
}

#[near]
impl PolicyContract {
    #[init]
    pub fn new(
        owner: AccountId,
        agent: AccountId,
        mpc_signer: AccountId,
        portfolio_id: String,
        verifying_contract: String,
        limits: PolicyLimits,
    ) -> Self {
        require!(!env::state_exists(), "already initialized");
        require!(!portfolio_id.is_empty(), "portfolio_id required");
        require!(!verifying_contract.is_empty(), "verifying_contract required");
        require!(
            !portfolio_id.contains('/'),
            "portfolio_id must not contain '/'"
        );
        let scope = Self::normalize_token_scope(&limits.token_scope);
        require!(!scope.is_empty(), "invalid token_scope");
        require!(!limits.allowed_chains.is_empty(), "allowed_chains required");
        if scope == "allowlist" {
            require!(
                !limits.allowed_assets.is_empty(),
                "allowlist requires allowed_assets"
            );
        }
        require!(
            limits.max_gas_budget.0 > 0,
            "max_gas_budget required (zero is not unlimited)"
        );
        Self {
            owner,
            agent,
            mpc_signer,
            portfolio_id,
            intents_signer_id: String::new(),
            verifying_contract,
            mandate_epoch: 1,
            // Inert-by-default: agent propose/sign blocked until owner unpause
            // after a separately authorized trading-readiness review.
            paused: true,
            revoked: false,
            strategy_hash: String::new(),
            policy_hash: String::new(),
            limits,
            next_operation_nonce: 1,
            pending: IterableMap::new(b"p"),
            reserved_pending_exposure: 0,
            realized_exposure: 0,
            daily_turnover: 0,
            daily_turnover_day: 0,
        }
    }

    /// Owner registers the EVM address derived from this contract's MPC key (off-chain derive, on-chain bind).
    pub fn set_intents_signer_id(&mut self, intents_signer_id: String) {
        self.assert_owner();
        let id = intents_signer_id.trim().to_lowercase();
        require!(
            id.starts_with("0x") && id.len() == 42 && id[2..].bytes().all(|b| b.is_ascii_hexdigit()),
            "intents_signer_id must be 0x + 40 hex"
        );
        self.intents_signer_id = id;
        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"intents_signer_set\",\"signer_id\":\"{}\"}}",
            self.intents_signer_id
        ));
    }

    // ─── owner high-authority ops (Ledger path) ───────────────────────────

    pub fn set_policy(
        &mut self,
        limits: PolicyLimits,
        policy_hash: String,
        strategy_hash: String,
    ) {
        self.assert_owner();
        require!(!self.revoked, "revoked: create a new mandate epoch via unrevoke flow first");
        let scope = Self::normalize_token_scope(&limits.token_scope);
        require!(!scope.is_empty(), "invalid token_scope");
        require!(!limits.allowed_chains.is_empty(), "allowed_chains required");
        if scope == "allowlist" {
            require!(
                !limits.allowed_assets.is_empty(),
                "allowlist requires allowed_assets"
            );
        }
        // Zero previously meant "unlimited" — rejected: funded paths need an explicit cap.
        require!(
            limits.max_gas_budget.0 > 0,
            "max_gas_budget required (zero is not unlimited)"
        );
        // any_eligible_token is explicit — empty allowlist assets OK, but chains required.
        self.limits = limits;
        self.policy_hash = policy_hash;
        self.strategy_hash = strategy_hash;
        self.mandate_epoch += 1;
        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"policy_updated\",\"epoch\":{},\"policy_hash\":\"{}\"}}",
            self.mandate_epoch, self.policy_hash
        ));
    }

    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        env::log_str("EVENT_JSON:{\"event\":\"paused\"}");
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        require!(!self.revoked, "cannot unpause while revoked");
        self.paused = false;
        env::log_str("EVENT_JSON:{\"event\":\"unpaused\"}");
    }

    /// Increments mandate_epoch and blocks all future signing. Outstanding
    /// signed intents remain as pending exposure until terminal/expiry.
    pub fn revoke(&mut self) {
        self.assert_owner();
        self.revoked = true;
        self.paused = true;
        self.mandate_epoch += 1;
        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"revoked\",\"epoch\":{}}}",
            self.mandate_epoch
        ));
    }

    /// Owner-only reactivation after revoke. Clears revoked/paused and opens a
    /// fresh mandate epoch. Derivation path stays portfolio-stable; custody
    /// identity is unchanged. Does not erase historical pending ops — settle
    /// or expire them separately before relying on exposure caps.
    pub fn unrevoke(&mut self) {
        self.assert_owner();
        require!(self.revoked, "not revoked");
        self.revoked = false;
        self.paused = false;
        self.mandate_epoch += 1;
        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"unrevoked\",\"epoch\":{}}}",
            self.mandate_epoch
        ));
    }

    /// Owner pins a trusted ed25519 quote attestor (`ed25519:<base58>`).
    /// Stored in raw storage so upgrades do not require Borsh migration.
    pub fn set_trusted_quote_signer(&mut self, public_key: String) {
        self.assert_owner();
        let pk = Self::normalize_ed25519_key(&public_key);
        env::storage_write(&Self::trusted_signer_storage_key(&pk), &[1]);
        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"trusted_quote_signer_set\",\"public_key\":\"{}\"}}",
            pk
        ));
    }

    pub fn remove_trusted_quote_signer(&mut self, public_key: String) {
        self.assert_owner();
        let pk = Self::normalize_ed25519_key(&public_key);
        env::storage_remove(&Self::trusted_signer_storage_key(&pk));
        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"trusted_quote_signer_removed\",\"public_key\":\"{}\"}}",
            pk
        ));
    }

    pub fn is_trusted_quote_signer(&self, public_key: String) -> bool {
        let pk = Self::normalize_ed25519_key(&public_key);
        env::storage_has_key(&Self::trusted_signer_storage_key(&pk))
    }

    /// Gate F1: authorize EVM ERC-20 transfer from a V2 quote attestation without
    /// per-deposit allowlisting. Digest is computed on-chain from exact EIP-155 fields.
    pub fn propose_quoted_evm_transfer(
        &mut self,
        operation_id: String,
        attestation: QuoteAttestation,
        attestation_signature: String,
        signer_public_key: String,
        tx: EvmTxParams,
        expected_epoch: u64,
    ) -> PendingOp {
        self.assert_agent();
        self.assert_active_mandate();
        require!(expected_epoch == self.mandate_epoch, "stale mandate epoch");
        require!(
            self.pending.get(&operation_id).is_none(),
            "operation_id already exists"
        );

        let signer_pk = Self::normalize_ed25519_key(&signer_public_key);
        require!(
            env::storage_has_key(&Self::trusted_signer_storage_key(&signer_pk)),
            "quote signer not trusted"
        );

        let deposit = attestation.deposit_address.trim().to_lowercase();
        let token = attestation.token_contract.trim().to_lowercase();
        let recipient = attestation.recipient.trim().to_lowercase();
        let refund_to = attestation.refund_to.trim().to_lowercase();
        require!(
            deposit.starts_with("0x") && deposit.len() == 42,
            "bad deposit_address"
        );
        require!(token.starts_with("0x") && token.len() == 42, "bad token_contract");
        require!(!attestation.correlation_id.is_empty(), "correlation_id required");
        require!(!attestation.quote_hash.is_empty(), "quote_hash required");
        require!(!recipient.is_empty(), "recipient required");
        require!(!refund_to.is_empty(), "refund_to required");
        // Final swap destination + refund must be mandate-allowlisted.
        // Deposit address is bound separately via attestation+tx.to (1Click escrow).
        require!(
            self.destination_allowed(&recipient),
            "recipient not allowed"
        );
        require!(
            self.destination_allowed(&refund_to),
            "refund_to not allowed"
        );
        require!(attestation.amount_in.0 > 0, "amount_in must be > 0");
        require!(
            attestation.amount_in.0 <= self.limits.max_trade_value.0,
            "exceeds max_trade_value"
        );
        require!(
            self.asset_permitted(&attestation.asset_in),
            "asset_in not allowed"
        );
        require!(
            self.asset_permitted(&attestation.asset_out),
            "asset_out not allowed"
        );
        require!(
            self.chain_permitted_evm(attestation.chain_id.0),
            "chain_id not in allowed_chains"
        );
        require!(
            self.venue_permitted("near_intents_1click")
                || self.venue_permitted("evm_0x"),
            "venue not permitted for quoted evm transfer"
        );
        // ANY_ELIGIBLE_TOKEN remains NOT SAFE FOR FUNDED EVM SIGN until deterministic
        // token-risk + destination restrictions are complete. Signing path = allowlist only.
        require!(
            Self::normalize_token_scope(&self.limits.token_scope) == "allowlist",
            "any_eligible_token_not_safe_for_evm_sign"
        );
        require!(
            attestation.quote_deadline_ns.0 > env::block_timestamp(),
            "quote attestation expired"
        );
        require!(attestation.gas_limit.0 > 0, "attested gas_limit required");
        require!(attestation.max_gas_price.0 > 0, "max_gas_price required");
        require!(
            self.limits.max_gas_budget.0 > 0,
            "max_gas_budget required (zero is not unlimited)"
        );
        let gas_cost = (attestation.max_gas_price.0 as u128)
            .saturating_mul(attestation.gas_limit.0 as u128);
        require!(
            gas_cost <= self.limits.max_gas_budget.0,
            "exceeds max_gas_budget"
        );

        let min_ratio_bps = 10_000u128.saturating_sub(self.limits.max_slippage_bps as u128);
        let floor = attestation
            .amount_in
            .0
            .saturating_mul(min_ratio_bps)
            / 10_000;
        require!(
            attestation.min_amount_out.0 >= floor
                || attestation.min_amount_out.0 >= attestation.amount_in.0,
            "min_amount_out below slippage bound"
        );

        let msg = evm_auth::attestation_message_v2(
            &deposit,
            attestation.amount_in.0,
            &attestation.asset_in,
            &attestation.asset_out,
            attestation.min_amount_out.0,
            attestation.quote_deadline_ns.0,
            &token,
            attestation.chain_id.0,
            &recipient,
            &refund_to,
            &attestation.correlation_id,
            &attestation.quote_hash,
            attestation.max_gas_price.0,
            attestation.gas_limit.0,
        );
        require!(
            Self::verify_ed25519(&signer_pk, &attestation_signature, &msg),
            "invalid quote attestation signature"
        );

        // Replay / duplicate attestation protection (Gate F1).
        let att_id = evm_auth::attestation_id(&msg);
        let att_key = Self::attestation_used_key(&att_id);
        require!(!env::storage_has_key(&att_key), "attestation already used");

        // Exact EIP-155 field binding.
        let tx_to = tx.to.trim().to_lowercase();
        let tx_token = tx.token_contract.trim().to_lowercase();
        require!(tx_to == deposit, "tx.to != attested deposit");
        require!(tx_token == token, "tx.token != attested token");
        require!(tx.amount.0 == attestation.amount_in.0, "tx.amount != attested amount");
        require!(tx.chain_id.0 == attestation.chain_id.0, "tx.chain_id mismatch");
        require!(tx.gas_limit.0 == attestation.gas_limit.0, "tx.gas_limit != attested");
        require!(
            tx.gas_price.0 > 0 && tx.gas_price.0 <= attestation.max_gas_price.0,
            "tx.gas_price out of attested bounds"
        );

        let to_bytes = evm_auth::parse_hex_address(&tx_to);
        let token_bytes = evm_auth::parse_hex_address(&tx_token);
        let data = evm_auth::erc20_transfer_data(&to_bytes, tx.amount.0);
        let digest = evm_auth::eip155_unsigned_digest(
            tx.nonce.0,
            tx.gas_price.0,
            tx.gas_limit.0,
            &token_bytes,
            0,
            &data,
            tx.chain_id.0,
        );
        let digest_hex = evm_auth::digest_hex(&digest);

        let amount = attestation.amount_in.0;
        require!(
            self.reserved_pending_exposure
                .checked_add(amount)
                .expect("overflow")
                <= self.limits.max_pending_exposure.0,
            "aggregate pending exposure exceeded"
        );
        self.bump_daily_turnover(amount);

        // Consume attestation id before insert (prevents duplicate reserve).
        env::storage_write(&att_key, &[1]);

        let op = PendingOp {
            epoch: self.mandate_epoch,
            amount_in: attestation.amount_in,
            asset_in: attestation.asset_in.clone(),
            asset_out: attestation.asset_out.clone(),
            destination: deposit.clone(),
            min_amount_out: attestation.min_amount_out,
            requested_at: env::block_timestamp(),
            intent_deadline: attestation.quote_deadline_ns.0,
            payload_commitment: digest_hex.clone(),
            intent_payload: attestation.correlation_id.clone(),
            signing_state: SigningState::Reserved,
            settlement_state: SettlementState::None,
        };
        self.reserved_pending_exposure += amount;
        self.pending.insert(operation_id.clone(), op.clone());
        self.next_operation_nonce += 1;

        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"quoted_evm_reserved\",\"operation_id\":\"{}\",\"epoch\":{},\"deposit\":\"{}\",\"digest\":\"{}\",\"amount_in\":\"{}\",\"correlation_id\":\"{}\"}}",
            operation_id, op.epoch, deposit, digest_hex, amount, attestation.correlation_id
        ));
        op
    }

    /// Gate F2: owner-only post-revoke nonce replacement. Signs a 0-value self-transfer
    /// at `nonce` so a previously exported conflicting tx can be raced/cancelled on EVM.
    /// Does NOT allow arbitrary destinations or calldata.
    #[payable]
    pub fn owner_request_cancel_signature(
        &mut self,
        operation_id: String,
        cancel: EvmCancelParams,
    ) -> Promise {
        self.assert_owner();
        require!(self.revoked, "cancel path only after revoke");
        require!(
            env::attached_deposit() >= ONE_YOCTO,
            "attach at least 1 yoctoNEAR for MPC sign"
        );
        require!(
            self.pending.get(&operation_id).is_none(),
            "operation_id already exists"
        );
        require!(!self.intents_signer_id.is_empty(), "intents_signer_id not configured");
        require!(cancel.gas_limit.0 > 0 && cancel.gas_limit.0 <= 100_000, "cancel gas_limit bound");
        require!(cancel.gas_price.0 > 0, "gas_price required");
        // Sepolia only for hackathon cancel path.
        require!(
            self.chain_permitted_evm(cancel.chain_id.0),
            "cancel chain_id not in allowed_chains"
        );

        let self_addr = evm_auth::parse_hex_address(&self.intents_signer_id);
        let digest = evm_auth::eip155_unsigned_digest(
            cancel.nonce.0,
            cancel.gas_price.0,
            cancel.gas_limit.0,
            &self_addr,
            0,
            &[],
            cancel.chain_id.0,
        );
        let digest_hex = evm_auth::digest_hex(&digest);

        let op = PendingOp {
            epoch: self.mandate_epoch,
            amount_in: U128(0),
            asset_in: "evm_cancel".into(),
            asset_out: "evm_cancel".into(),
            destination: self.intents_signer_id.clone(),
            min_amount_out: U128(0),
            requested_at: env::block_timestamp(),
            intent_deadline: env::block_timestamp().saturating_add(3_600_000_000_000),
            payload_commitment: digest_hex.clone(),
            intent_payload: format!("cancel_nonce:{}", cancel.nonce.0),
            signing_state: SigningState::Reserved,
            settlement_state: SettlementState::None,
        };
        self.pending.insert(operation_id.clone(), op);

        // Bypass assert_active_mandate: we are revoked by design.
        let path = self.derivation_path();
        let request = SignRequest {
            path,
            payload_v2: Payload::Ecdsa(digest_hex.clone()),
            domain_id: DOMAIN_SECP256K1,
        };
        let epoch = self.mandate_epoch;
        // Mark Signing without going through request_signature (which asserts active).
        let mut op2 = self.pending.get(&operation_id).unwrap().clone();
        op2.signing_state = SigningState::Signing;
        self.pending.insert(operation_id.clone(), op2);

        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"cancel_sign_requested\",\"operation_id\":\"{}\",\"nonce\":{},\"digest\":\"{}\"}}",
            operation_id, cancel.nonce.0, digest_hex
        ));

        ext_mpc::ext(self.mpc_signer.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(SIGN_GAS)
            .sign(request)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_cancel_signature(operation_id, epoch),
            )
    }

    /// Gate I2: owner-only ERC-20 withdraw/recovery. Works while paused or revoked
    /// (and while active). Destination must be allowlisted. Agent cannot call.
    #[payable]
    pub fn owner_request_withdraw_signature(
        &mut self,
        operation_id: String,
        withdraw: EvmWithdrawParams,
    ) -> Promise {
        self.assert_owner();
        require!(
            env::attached_deposit() >= ONE_YOCTO,
            "attach at least 1 yoctoNEAR for MPC sign"
        );
        require!(
            self.pending.get(&operation_id).is_none(),
            "operation_id already exists"
        );
        require!(!self.intents_signer_id.is_empty(), "intents_signer_id not configured");
        require!(withdraw.amount.0 > 0, "amount required");
        require!(
            withdraw.gas_limit.0 > 0 && withdraw.gas_limit.0 <= 300_000,
            "withdraw gas_limit bound"
        );
        require!(withdraw.gas_price.0 > 0, "gas_price required");
        require!(
            self.chain_permitted_evm(withdraw.chain_id.0),
            "withdraw chain_id not in allowed_chains"
        );

        let to = withdraw.to.trim().to_lowercase();
        require!(
            self.limits
                .allowed_destinations
                .iter()
                .any(|d| d.to_lowercase() == to),
            "withdraw destination not allowlisted"
        );

        let token = withdraw.token_contract.trim().to_lowercase();
        let token_addr = evm_auth::parse_hex_address(&token);
        let to_addr = evm_auth::parse_hex_address(&to);
        let data = evm_auth::erc20_transfer_data(&to_addr, withdraw.amount.0);
        let digest = evm_auth::eip155_unsigned_digest(
            withdraw.nonce.0,
            withdraw.gas_price.0,
            withdraw.gas_limit.0,
            &token_addr,
            0,
            &data,
            withdraw.chain_id.0,
        );
        let digest_hex = evm_auth::digest_hex(&digest);

        let op = PendingOp {
            epoch: self.mandate_epoch,
            amount_in: withdraw.amount,
            asset_in: format!("withdraw:{}", token),
            asset_out: "evm_transfer".into(),
            destination: to.clone(),
            min_amount_out: U128(0),
            requested_at: env::block_timestamp(),
            intent_deadline: env::block_timestamp().saturating_add(3_600_000_000_000),
            payload_commitment: digest_hex.clone(),
            intent_payload: format!("withdraw:{}:{}", token, withdraw.amount.0),
            signing_state: SigningState::Reserved,
            settlement_state: SettlementState::None,
        };
        self.pending.insert(operation_id.clone(), op);

        let path = self.derivation_path();
        let request = SignRequest {
            path,
            payload_v2: Payload::Ecdsa(digest_hex.clone()),
            domain_id: DOMAIN_SECP256K1,
        };
        let epoch = self.mandate_epoch;
        let mut op2 = self.pending.get(&operation_id).unwrap().clone();
        op2.signing_state = SigningState::Signing;
        self.pending.insert(operation_id.clone(), op2);

        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"withdraw_sign_requested\",\"operation_id\":\"{}\",\"to\":\"{}\",\"token\":\"{}\",\"amount\":\"{}\",\"digest\":\"{}\",\"paused\":{},\"revoked\":{}}}",
            operation_id, to, token, withdraw.amount.0, digest_hex, self.paused, self.revoked
        ));

        ext_mpc::ext(self.mpc_signer.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(SIGN_GAS)
            .sign(request)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_withdraw_signature(operation_id, epoch),
            )
    }

    #[private]
    pub fn on_withdraw_signature(
        &mut self,
        operation_id: String,
        request_epoch: u64,
        #[callback_result] result: Result<SignatureResponse, PromiseError>,
    ) -> Option<SignatureResponse> {
        let Some(mut op) = self.pending.get(&operation_id).cloned() else {
            return None;
        };
        if request_epoch != op.epoch {
            op.signing_state = SigningState::RolledBack;
            self.pending.insert(operation_id, op);
            return None;
        }
        match result {
            Ok(signature) => {
                op.signing_state = SigningState::Signed;
                self.pending.insert(operation_id.clone(), op);
                env::log_str(&format!(
                    "EVENT_JSON:{{\"event\":\"withdraw_signed\",\"operation_id\":\"{}\"}}",
                    operation_id
                ));
                Some(signature)
            }
            Err(_) => {
                op.signing_state = SigningState::RolledBack;
                self.pending.insert(operation_id, op);
                None
            }
        }
    }

    #[private]
    pub fn on_cancel_signature(
        &mut self,
        operation_id: String,
        request_epoch: u64,
        #[callback_result] result: Result<SignatureResponse, PromiseError>,
    ) -> Option<SignatureResponse> {
        let Some(mut op) = self.pending.get(&operation_id).cloned() else {
            return None;
        };
        // Cancel callbacks are allowed while revoked; still bind to request epoch.
        if request_epoch != op.epoch {
            op.signing_state = SigningState::RolledBack;
            self.pending.insert(operation_id, op);
            return None;
        }
        match result {
            Ok(signature) => {
                op.signing_state = SigningState::Signed;
                self.pending.insert(operation_id.clone(), op);
                env::log_str(&format!(
                    "EVENT_JSON:{{\"event\":\"cancel_signed\",\"operation_id\":\"{}\"}}",
                    operation_id
                ));
                Some(signature)
            }
            Err(_) => {
                op.signing_state = SigningState::RolledBack;
                self.pending.insert(operation_id, op);
                None
            }
        }
    }

    /// Owner pins a narrowly authorized reconciler (Gate G). May call
    /// `reconcile_pending` but cannot set_policy / revoke / unrevoke / pause.
    pub fn set_reconciler(&mut self, reconciler: AccountId) {
        self.assert_owner();
        env::storage_write(
            &Self::reconciler_storage_key(),
            reconciler.as_bytes(),
        );
        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"reconciler_set\",\"account\":\"{}\"}}",
            reconciler
        ));
    }

    pub fn clear_reconciler(&mut self) {
        self.assert_owner();
        env::storage_remove(&Self::reconciler_storage_key());
        env::log_str("EVENT_JSON:{\"event\":\"reconciler_cleared\"}");
    }

    pub fn get_reconciler(&self) -> Option<AccountId> {
        env::storage_read(&Self::reconciler_storage_key()).map(|b| {
            AccountId::try_from(String::from_utf8(b).expect("utf8")).expect("account")
        })
    }

    /// Gate F2/G: mark terminal settlement with a *stored* evidence hash.
    /// IMPORTANT: the contract does NOT independently verify the hash against
    /// Tidepool/Sepolia. Trust is delegated to owner or the owner-pinned
    /// `reconciler` account. Watchdogs must verify receipts off-chain before calling.
    pub fn reconcile_pending(
        &mut self,
        operation_id: String,
        settlement_state: SettlementState,
        evidence_hash: String,
    ) {
        self.assert_owner_or_reconciler();
        require!(
            !evidence_hash.is_empty() && evidence_hash.len() <= 128,
            "evidence_hash required"
        );
        let terminal = matches!(
            settlement_state,
            SettlementState::Success
                | SettlementState::Refunded
                | SettlementState::Failed
                | SettlementState::Expired
                | SettlementState::Reconciled
        );
        require!(terminal, "settlement_state must be terminal");
        self.mark_settlement(operation_id.clone(), settlement_state);
        // Persist evidence pointer (not a proof).
        env::storage_write(
            &Self::evidence_storage_key(&operation_id),
            evidence_hash.as_bytes(),
        );
        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"reconciled\",\"operation_id\":\"{}\",\"evidence_hash\":\"{}\",\"verified_onchain\":false}}",
            operation_id, evidence_hash
        ));
    }

    pub fn get_evidence_hash(&self, operation_id: String) -> Option<String> {
        env::storage_read(&Self::evidence_storage_key(&operation_id))
            .map(|b| String::from_utf8(b).unwrap_or_default())
    }

    pub fn get_exposure_snapshot(&self) -> ExposureSnapshot {
        let (_, unresolved) = self.count_pending();
        ExposureSnapshot {
            reserved_pending_exposure: U128(self.reserved_pending_exposure),
            realized_exposure: U128(self.realized_exposure),
            revoked: self.revoked,
            mandate_epoch: self.mandate_epoch,
            unresolved_pending: unresolved,
            signing_revoked: self.revoked,
            economically_settled: unresolved == 0 && self.reserved_pending_exposure == 0,
        }
    }

    /// Accounting audit: enumerate all pending ops (Gate G).
    pub fn list_pending(&self) -> Vec<PendingOpSummary> {
        let mut out = Vec::new();
        for (id, op) in self.pending.iter() {
            let evidence = env::storage_read(&Self::evidence_storage_key(id))
                .map(|b| String::from_utf8(b).unwrap_or_default());
            out.push(PendingOpSummary {
                operation_id: id.clone(),
                epoch: op.epoch,
                amount_in: op.amount_in,
                destination: op.destination.clone(),
                signing_state: op.signing_state.clone(),
                settlement_state: op.settlement_state.clone(),
                payload_commitment: op.payload_commitment.clone(),
                intent_payload: op.intent_payload.clone(),
                evidence_hash: evidence,
            });
        }
        out
    }

    // ─── agent trade path ─────────────────────────────────────────────────

    /// Validate + reserve pending exposure. Does not call MPC yet.
    pub fn propose_trade(&mut self, proposal: TradeProposal) -> PendingOp {
        self.assert_agent();
        self.assert_active_mandate();
        require!(
            self.pending.get(&proposal.operation_id).is_none(),
            "operation_id already exists"
        );
        self.validate_proposal(&proposal);

        let amount = proposal.amount_in.0;
        require!(
            self.reserved_pending_exposure
                .checked_add(amount)
                .expect("overflow")
                <= self.limits.max_pending_exposure.0,
            "aggregate pending exposure exceeded"
        );

        self.bump_daily_turnover(amount);

        let op = PendingOp {
            epoch: self.mandate_epoch,
            amount_in: proposal.amount_in,
            asset_in: proposal.asset_in,
            asset_out: proposal.asset_out,
            destination: proposal.destination,
            min_amount_out: proposal.min_amount_out,
            requested_at: env::block_timestamp(),
            intent_deadline: proposal.intent_deadline.0,
            payload_commitment: Self::normalize_commitment(&proposal.payload_commitment),
            intent_payload: String::new(),
            signing_state: SigningState::Reserved,
            settlement_state: SettlementState::None,
        };

        self.reserved_pending_exposure += amount;
        self.pending.insert(proposal.operation_id.clone(), op.clone());
        self.next_operation_nonce += 1;

        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"reserved\",\"operation_id\":\"{}\",\"epoch\":{},\"amount_in\":\"{}\"}}",
            proposal.operation_id, op.epoch, amount
        ));
        op
    }

    /// Validate exact ERC-191 intent JSON semantics, bind epoch, reserve exposure,
    /// and store EIP-191 digest as the only hash eligible for MPC signing.
    pub fn propose_intent(
        &mut self,
        operation_id: String,
        payload_json: String,
        expected_epoch: u64,
    ) -> PendingOp {
        self.assert_agent();
        self.assert_active_mandate();
        require!(
            expected_epoch == self.mandate_epoch,
            "stale mandate epoch"
        );
        require!(
            self.pending.get(&operation_id).is_none(),
            "operation_id already exists"
        );
        require!(
            !self.intents_signer_id.is_empty(),
            "intents_signer_id not configured"
        );

        let parsed = self.validate_intent_payload(&payload_json);
        let amount = parsed.amount;
        require!(
            self.reserved_pending_exposure
                .checked_add(amount)
                .expect("overflow")
                <= self.limits.max_pending_exposure.0,
            "aggregate pending exposure exceeded"
        );
        self.bump_daily_turnover(amount);

        let digest = Self::eip191_digest_hex(payload_json.as_bytes());
        let op = PendingOp {
            epoch: self.mandate_epoch,
            amount_in: U128(amount),
            asset_in: parsed.asset_in,
            asset_out: parsed.asset_out,
            destination: parsed.destination,
            min_amount_out: U128(0),
            requested_at: env::block_timestamp(),
            intent_deadline: parsed.deadline_ns,
            payload_commitment: digest,
            intent_payload: payload_json,
            signing_state: SigningState::Reserved,
            settlement_state: SettlementState::None,
        };

        self.reserved_pending_exposure += amount;
        self.pending.insert(operation_id.clone(), op.clone());
        self.next_operation_nonce += 1;

        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"intent_reserved\",\"operation_id\":\"{}\",\"epoch\":{},\"digest\":\"{}\",\"amount_in\":\"{}\"}}",
            operation_id, op.epoch, op.payload_commitment, amount
        ));
        op
    }

    /// Contract constructs the signing request. Path is contract-derived; payload
    /// is the reserved operation's commitment — never an arbitrary agent hash path.
    #[payable]
    pub fn request_signature(&mut self, operation_id: String) -> Promise {
        self.assert_agent();
        self.assert_active_mandate();
        require!(
            env::attached_deposit() >= ONE_YOCTO,
            "attach at least 1 yoctoNEAR for MPC sign"
        );

        let mut op = self
            .pending
            .get(&operation_id)
            .cloned()
            .expect("unknown operation_id");
        require!(
            op.signing_state == SigningState::Reserved,
            "operation not in Reserved state"
        );
        require!(
            op.epoch == self.mandate_epoch,
            "stale mandate epoch"
        );
        require!(
            env::block_timestamp() < op.intent_deadline,
            "intent deadline exceeded"
        );

        op.signing_state = SigningState::Signing;
        self.pending.insert(operation_id.clone(), op.clone());

        let path = self.derivation_path();
        let request = SignRequest {
            path,
            payload_v2: Payload::Ecdsa(op.payload_commitment.clone()),
            domain_id: DOMAIN_SECP256K1,
        };

        let epoch = op.epoch;
        ext_mpc::ext(self.mpc_signer.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(SIGN_GAS)
            .sign(request)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_signature(operation_id, epoch),
            )
    }

    /// MPC callback: on success mark Signed; on timeout/error roll back reservation
    /// only if the mandate epoch that created the request is still current OR we
    /// still hold that pending reservation. Never submit under a revoked/newer epoch.
    #[private]
    pub fn on_signature(
        &mut self,
        operation_id: String,
        request_epoch: u64,
        #[callback_result] result: Result<SignatureResponse, PromiseError>,
    ) -> Option<SignatureResponse> {
        let Some(mut op) = self.pending.get(&operation_id).cloned() else {
            env::log_str(&format!(
                "EVENT_JSON:{{\"event\":\"callback_orphan\",\"operation_id\":\"{}\"}}",
                operation_id
            ));
            return None;
        };

        // If revoke rotated the epoch after we requested signing, refuse release.
        if self.revoked || request_epoch != op.epoch {
            env::log_str(&format!(
                "EVENT_JSON:{{\"event\":\"callback_blocked_after_revoke\",\"operation_id\":\"{}\",\"request_epoch\":{},\"current_epoch\":{}}}",
                operation_id, request_epoch, self.mandate_epoch
            ));
            // Keep reservation until owner/watchdog expires or settles if already signed off-contract.
            if op.signing_state == SigningState::Signing {
                op.signing_state = SigningState::RolledBack;
                self.release_reservation(op.amount_in.0);
                self.pending.insert(operation_id.clone(), op.clone());
            }
            return None;
        }

        match result {
            Ok(signature) => {
                op.signing_state = SigningState::Signed;
                self.pending.insert(operation_id.clone(), op.clone());
                env::log_str(&format!(
                    "EVENT_JSON:{{\"event\":\"signed\",\"operation_id\":\"{}\"}}",
                    operation_id
                ));
                Some(signature)
            }
            Err(_) => {
                op.signing_state = SigningState::RolledBack;
                self.release_reservation(op.amount_in.0);
                self.pending.insert(operation_id.clone(), op.clone());
                env::log_str(&format!(
                    "EVENT_JSON:{{\"event\":\"mpc_timeout_or_error\",\"operation_id\":\"{}\"}}",
                    operation_id
                ));
                None
            }
        }
    }

    /// Watchdog / trusted settlement transition. Releases pending exposure once.
    /// Callable by owner, reconciler, or self (callback).
    pub fn mark_settlement(
        &mut self,
        operation_id: String,
        settlement_state: SettlementState,
    ) {
        let pred = env::predecessor_account_id();
        let ok = pred == self.owner
            || pred == env::current_account_id()
            || self.is_reconciler(&pred);
        require!(ok, "only owner, reconciler, or self");

        let mut op = self
            .pending
            .get(&operation_id)
            .cloned()
            .expect("unknown operation_id");

        let terminal = matches!(
            settlement_state,
            SettlementState::Success
                | SettlementState::Refunded
                | SettlementState::Failed
                | SettlementState::Expired
                | SettlementState::Reconciled
        );
        require!(terminal, "settlement_state must be terminal");

        let already_terminal = matches!(
            op.settlement_state,
            SettlementState::Success
                | SettlementState::Refunded
                | SettlementState::Failed
                | SettlementState::Expired
                | SettlementState::Reconciled
        );
        require!(!already_terminal, "already terminal");

        // Release reserved exposure exactly once for signed/reserved ops that held it.
        if op.signing_state == SigningState::Signed
            || op.signing_state == SigningState::Reserved
            || op.signing_state == SigningState::Signing
        {
            self.release_reservation(op.amount_in.0);
        }

        if settlement_state == SettlementState::Success {
            self.realized_exposure = self
                .realized_exposure
                .saturating_add(op.amount_in.0);
        }

        op.settlement_state = settlement_state;
        self.pending.insert(operation_id.clone(), op.clone());

        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"settlement\",\"operation_id\":\"{}\",\"state\":\"{:?}\"}}",
            operation_id, op.settlement_state
        ));
    }

    // ─── views ────────────────────────────────────────────────────────────

    pub fn get_pending(&self, operation_id: String) -> Option<PendingOp> {
        self.pending.get(&operation_id).cloned()
    }

    pub fn get_revocation_status(&self) -> RevocationStatus {
        let (active_signing, unresolved) = self.count_pending();
        let fully_revoked =
            self.revoked && active_signing == 0 && unresolved == 0;
        RevocationStatus {
            revoked: self.revoked,
            mandate_epoch: self.mandate_epoch,
            active_signing_requests: active_signing,
            unresolved_pending: unresolved,
            fully_revoked,
        }
    }

    pub fn get_mandate_epoch(&self) -> u64 {
        self.mandate_epoch
    }

    pub fn get_derivation_path(&self) -> String {
        self.derivation_path()
    }

    pub fn get_reserved_pending_exposure(&self) -> U128 {
        U128(self.reserved_pending_exposure)
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_agent(&self) -> AccountId {
        self.agent.clone()
    }

    pub fn get_mpc_signer(&self) -> AccountId {
        self.mpc_signer.clone()
    }

    pub fn get_portfolio_id(&self) -> String {
        self.portfolio_id.clone()
    }

    pub fn get_intents_signer_id(&self) -> String {
        self.intents_signer_id.clone()
    }

    pub fn get_verifying_contract(&self) -> String {
        self.verifying_contract.clone()
    }

    pub fn get_limits(&self) -> PolicyLimits {
        self.limits.clone()
    }

    pub fn get_paused(&self) -> bool {
        self.paused
    }

    pub fn get_policy_hash(&self) -> String {
        self.policy_hash.clone()
    }

    pub fn get_daily_turnover(&self) -> U128 {
        U128(self.daily_turnover)
    }

    /// Gate K: owner enables/disables unattended AI-directed trading.
    /// Default OFF (missing storage key). Does not grant per-trade approval bypass of limits.
    pub fn set_autonomous_trading(&mut self, enabled: bool) {
        self.assert_owner();
        require!(!self.revoked, "revoked");
        env::storage_write(&Self::autonomous_trading_key(), &[u8::from(enabled)]);
        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"autonomous_trading\",\"enabled\":{}}}",
            enabled
        ));
    }

    pub fn get_autonomous_trading(&self) -> bool {
        env::storage_read(&Self::autonomous_trading_key())
            .map(|b| !b.is_empty() && b[0] != 0)
            .unwrap_or(false)
    }

    /// Autonomous Mandate V1: when enabled, agent propose/sign also requires
    /// `autonomous_trading == true`. Default OFF preserves canary/operator
    /// unpause windows that do not set the autonomous flag.
    /// Owner-only. Never deploy this toggle as agent-callable.
    pub fn set_enforce_autonomous_on_agent(&mut self, enabled: bool) {
        self.assert_owner();
        require!(!self.revoked, "revoked");
        env::storage_write(&Self::enforce_autonomous_on_agent_key(), &[u8::from(enabled)]);
        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"enforce_autonomous_on_agent\",\"enabled\":{}}}",
            enabled
        ));
    }

    pub fn get_enforce_autonomous_on_agent(&self) -> bool {
        env::storage_read(&Self::enforce_autonomous_on_agent_key())
            .map(|b| !b.is_empty() && b[0] != 0)
            .unwrap_or(false)
    }

    /// Gate J/K: single authoritative mandate snapshot for off-chain fitter hydration.
    /// Read-only. Never grants signing rights.
    pub fn get_gate_j_mandate(&self) -> GateJMandateView {
        let (_, unresolved) = self.count_pending();
        GateJMandateView {
            portfolio_id: self.portfolio_id.clone(),
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            policy_hash: self.policy_hash.clone(),
            mandate_epoch: self.mandate_epoch,
            paused: self.paused,
            revoked: self.revoked,
            signing_revoked: self.revoked,
            autonomous_trading: self.get_autonomous_trading(),
            limits: self.limits.clone(),
            reserved_pending_exposure: U128(self.reserved_pending_exposure),
            realized_exposure: U128(self.realized_exposure),
            daily_turnover: U128(self.daily_turnover),
            unresolved_pending: unresolved,
            intents_signer_id: self.intents_signer_id.clone(),
        }
    }

    /// Pure helper for tests / off-chain parity checks.
    pub fn eip191_digest(&self, payload_json: String) -> String {
        Self::eip191_digest_hex(payload_json.as_bytes())
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct GateJMandateView {
    pub portfolio_id: String,
    pub owner: AccountId,
    pub agent: AccountId,
    pub policy_hash: String,
    pub mandate_epoch: u64,
    pub paused: bool,
    pub revoked: bool,
    pub signing_revoked: bool,
    /// Owner-toggled Gate K unattended AI trading (default false).
    pub autonomous_trading: bool,
    pub limits: PolicyLimits,
    pub reserved_pending_exposure: U128,
    pub realized_exposure: U128,
    pub daily_turnover: U128,
    pub unresolved_pending: u64,
    pub intents_signer_id: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
struct ParsedIntent {
    amount: u128,
    asset_in: String,
    asset_out: String,
    destination: String,
    deadline_ns: u64,
}

impl PolicyContract {
    fn autonomous_trading_key() -> Vec<u8> {
        b"gate_k:autonomous_trading".to_vec()
    }

    fn enforce_autonomous_on_agent_key() -> Vec<u8> {
        b"gate_k:enforce_autonomous_on_agent".to_vec()
    }

    fn trusted_signer_storage_key(public_key: &str) -> Vec<u8> {
        let mut key = b"tqs:".to_vec();
        key.extend_from_slice(public_key.as_bytes());
        key
    }

    fn attestation_used_key(att_id: &[u8; 32]) -> Vec<u8> {
        let mut key = b"att:".to_vec();
        key.extend_from_slice(att_id);
        key
    }

    fn reconciler_storage_key() -> Vec<u8> {
        b"reconciler".to_vec()
    }

    fn evidence_storage_key(operation_id: &str) -> Vec<u8> {
        let mut key = b"evh:".to_vec();
        key.extend_from_slice(operation_id.as_bytes());
        key
    }

    fn is_reconciler(&self, account: &AccountId) -> bool {
        match env::storage_read(&Self::reconciler_storage_key()) {
            Some(b) => String::from_utf8(b).ok().as_deref() == Some(account.as_str()),
            None => false,
        }
    }

    fn assert_owner_or_reconciler(&self) {
        let pred = env::predecessor_account_id();
        require!(
            pred == self.owner || self.is_reconciler(&pred),
            "owner or reconciler only"
        );
    }

    fn normalize_ed25519_key(public_key: &str) -> String {
        let pk = public_key.trim();
        require!(
            pk.starts_with("ed25519:") && pk.len() > 8,
            "public_key must be ed25519:<base58>"
        );
        let raw = bs58::decode(&pk[8..])
            .into_vec()
            .expect("invalid base58 public_key");
        require!(raw.len() == 32, "ed25519 public_key must be 32 bytes");
        format!("ed25519:{}", bs58::encode(raw).into_string())
    }

    fn verify_ed25519(public_key: &str, signature: &str, message: &[u8]) -> bool {
        let pk_raw = bs58::decode(&public_key[8..])
            .into_vec()
            .unwrap_or_default();
        if pk_raw.len() != 32 {
            return false;
        }
        let mut pk = [0u8; 32];
        pk.copy_from_slice(&pk_raw);

        let sig_str = signature.trim();
        let sig_b58 = if sig_str.starts_with("ed25519:") {
            &sig_str[8..]
        } else {
            sig_str
        };
        let sig_raw = bs58::decode(sig_b58).into_vec().unwrap_or_default();
        if sig_raw.len() != 64 {
            return false;
        }
        let mut sig = [0u8; 64];
        sig.copy_from_slice(&sig_raw);
        env::ed25519_verify(&sig, message, &pk)
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "owner only"
        );
    }

    fn assert_agent(&self) {
        require!(
            env::predecessor_account_id() == self.agent,
            "agent only"
        );
    }

    fn normalize_token_scope(scope: &str) -> &str {
        let s = scope.trim();
        if s.is_empty() || s == "allowlist" {
            "allowlist"
        } else if s == "any_eligible_token" {
            "any_eligible_token"
        } else {
            ""
        }
    }

    /// ALLOWLIST: exact canonical asset id. ANY_ELIGIBLE_TOKEN: chain membership only
    /// (risk/liquidity still fail closed off-chain — never means arbitrary calldata).
    fn asset_permitted(&self, asset: &str) -> bool {
        let scope = Self::normalize_token_scope(&self.limits.token_scope);
        require!(!scope.is_empty(), "invalid token_scope");
        if scope == "allowlist" {
            return self.limits.allowed_assets.iter().any(|a| a == asset);
        }
        // any_eligible_token
        if let Some(chain) = Self::chain_of_asset(asset) {
            return self.limits.allowed_chains.iter().any(|c| c == &chain);
        }
        false
    }

    fn chain_of_asset(asset: &str) -> Option<String> {
        let a = asset.trim();
        if a == "native:near" || a.starts_with("nep141:") {
            return Some("near".into());
        }
        if let Some(rest) = a.strip_prefix("native:") {
            if rest.starts_with("eip155:") {
                return Some(rest.to_string());
            }
        }
        // eip155:<id>:0x…
        if a.starts_with("eip155:") {
            let parts: Vec<&str> = a.splitn(3, ':').collect();
            if parts.len() >= 2 {
                return Some(format!("{}:{}", parts[0], parts[1]));
            }
        }
        None
    }

    fn chain_permitted_evm(&self, chain_id: u64) -> bool {
        let tag = format!("eip155:{}", chain_id);
        self.limits.allowed_chains.iter().any(|c| c == &tag)
    }

    fn venue_permitted(&self, venue: &str) -> bool {
        if self.limits.allowed_venues.is_empty() {
            // Backward-compatible default for allowlist mandates that omit venues:
            // only near_intents_1click is implied — never open arbitrary venues.
            return venue == "near_intents_1click";
        }
        self.limits.allowed_venues.iter().any(|v| v == venue)
    }

    fn destination_allowed(&self, dest: &str) -> bool {
        let d = dest.trim().to_lowercase();
        self.limits
            .allowed_destinations
            .iter()
            .any(|allowed| allowed.trim().to_lowercase() == d)
    }

    fn assert_active_mandate(&self) {
        require!(!self.revoked, "revoked");
        require!(!self.paused, "paused");
        require!(
            env::block_timestamp() < self.limits.valid_until.0,
            "mandate expired"
        );
        // Optional hard gate for Autonomous Mandate V1. Default off so
        // operator-gated canaries (unpause without autonomous_trading) still work.
        if self.get_enforce_autonomous_on_agent() {
            require!(
                self.get_autonomous_trading(),
                "autonomous_trading_required"
            );
        }
    }

    fn derivation_path(&self) -> String {
        // Stable contract-owned path. Epoch is NOT in the path.
        format!("{}/{}", PATH_PREFIX, self.portfolio_id)
    }

    fn eip191_digest_hex(msg: &[u8]) -> String {
        let mut buf: Vec<u8> = Vec::with_capacity(32 + msg.len());
        buf.push(0x19);
        buf.extend_from_slice(b"Ethereum Signed Message:\n");
        buf.extend_from_slice(msg.len().to_string().as_bytes());
        buf.extend_from_slice(msg);
        let hash = env::keccak256_array(&buf);
        hex::encode(hash)
    }

    fn validate_intent_payload(&self, payload_json: &str) -> ParsedIntent {
        let v: serde_json::Value =
            serde_json::from_str(payload_json).expect("invalid intent JSON");
        let signer = v
            .get("signer_id")
            .and_then(|x| x.as_str())
            .expect("signer_id required")
            .to_lowercase();
        require!(
            signer == self.intents_signer_id,
            "signer_id mismatch"
        );

        let verifying = v
            .get("verifying_contract")
            .and_then(|x| x.as_str())
            .expect("verifying_contract required");
        require!(
            verifying == self.verifying_contract,
            "verifying_contract mismatch"
        );

        let deadline = v
            .get("deadline")
            .and_then(|x| x.as_str())
            .expect("deadline required");
        let deadline_ns = Self::parse_rfc3339_approx_ns(deadline);
        require!(
            deadline_ns > env::block_timestamp(),
            "intent deadline expired"
        );

        let nonce = v.get("nonce").and_then(|x| x.as_str()).expect("nonce required");
        require!(!nonce.is_empty(), "nonce empty");

        let intents = v
            .get("intents")
            .and_then(|x| x.as_array())
            .expect("intents required");
        require!(!intents.is_empty(), "intents empty");
        require!(intents.len() == 1, "Gate C allows exactly one intent");

        let intent = &intents[0];
        let kind = intent
            .get("intent")
            .and_then(|x| x.as_str())
            .expect("intent kind required");
        require!(kind == "transfer", "only transfer intents in Gate C");

        let receiver = intent
            .get("receiver_id")
            .and_then(|x| x.as_str())
            .expect("receiver_id required");
        require!(
            self.limits
                .allowed_destinations
                .iter()
                .any(|d| d == receiver),
            "destination not allowed"
        );

        let tokens = intent
            .get("tokens")
            .and_then(|x| x.as_object())
            .expect("tokens required");
        require!(tokens.len() == 1, "exactly one token in transfer");
        let (asset, amount_val) = tokens.iter().next().unwrap();
        let amount_str = amount_val.as_str().expect("token amount string");
        let amount: u128 = amount_str.parse().expect("token amount parse");
        require!(amount > 0, "amount must be > 0");
        require!(
            amount <= self.limits.max_trade_value.0,
            "exceeds max_trade_value"
        );
        require!(
            self.limits.allowed_assets.iter().any(|a| a == asset),
            "asset not allowed"
        );

        ParsedIntent {
            amount,
            asset_in: asset.clone(),
            asset_out: asset.clone(),
            destination: receiver.to_string(),
            deadline_ns,
        }
    }

    /// Accepts `YYYY-MM-DDTHH:MM:SS.sssZ` / `...Z` — sufficient for policy deadline checks.
    fn parse_rfc3339_approx_ns(s: &str) -> u64 {
        // Minimal parser: treat as unix millis from a known format via bytes.
        // For hackathon: require Zulu timestamps and encode as far-future check via
        // comparing lexicographic ISO against a constructed floor from block time is fragile.
        // Instead parse year/month/day/hour/min/sec roughly.
        let b = s.as_bytes();
        require!(b.len() >= 20, "deadline too short");
        let year: u64 = std::str::from_utf8(&b[0..4])
            .ok()
            .and_then(|x| x.parse().ok())
            .expect("year");
        let month: u64 = std::str::from_utf8(&b[5..7])
            .ok()
            .and_then(|x| x.parse().ok())
            .expect("month");
        let day: u64 = std::str::from_utf8(&b[8..10])
            .ok()
            .and_then(|x| x.parse().ok())
            .expect("day");
        let hour: u64 = std::str::from_utf8(&b[11..13])
            .ok()
            .and_then(|x| x.parse().ok())
            .expect("hour");
        let min: u64 = std::str::from_utf8(&b[14..16])
            .ok()
            .and_then(|x| x.parse().ok())
            .expect("min");
        let sec: u64 = std::str::from_utf8(&b[17..19])
            .ok()
            .and_then(|x| x.parse().ok())
            .expect("sec");
        // Approximate days since 1970 ignoring leap seconds; good enough vs block_timestamp ns.
        let y = year;
        require!((1..=12).contains(&month), "bad month");
        require!((1..=31).contains(&day), "bad day");
        let mut days = 0u64;
        for yy in 1970..y {
            days += if Self::is_leap(yy) { 366 } else { 365 };
        }
        let mdays = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        for m in 1..month {
            days += mdays[m as usize];
            if m == 2 && Self::is_leap(y) {
                days += 1;
            }
        }
        days += day - 1;
        let secs = days * 86400 + hour * 3600 + min * 60 + sec;
        secs.saturating_mul(1_000_000_000)
    }

    fn is_leap(y: u64) -> bool {
        (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
    }

    fn normalize_commitment(hex_str: &str) -> String {
        let cleaned = hex_str.trim().trim_start_matches("0x").to_lowercase();
        require!(
            cleaned.len() == 64 && cleaned.bytes().all(|b| b.is_ascii_hexdigit()),
            "payload_commitment must be 32-byte hex"
        );
        cleaned
    }

    fn validate_proposal(&self, proposal: &TradeProposal) {
        require!(!proposal.operation_id.is_empty(), "operation_id required");
        // Gate E2: agent-supplied payload_commitment must not authorize EVM txs.
        require!(
            !proposal.destination.to_lowercase().starts_with("0x"),
            "evm destinations require propose_quoted_evm_transfer"
        );
        require!(proposal.amount_in.0 > 0, "amount_in must be > 0");
        require!(
            proposal.amount_in.0 <= self.limits.max_trade_value.0,
            "exceeds max_trade_value"
        );
        require!(
            self.asset_permitted(&proposal.asset_in),
            "asset_in not allowed"
        );
        require!(
            self.asset_permitted(&proposal.asset_out),
            "asset_out not allowed"
        );
        require!(
            self.limits
                .allowed_destinations
                .iter()
                .any(|d| d == &proposal.destination),
            "destination not allowed"
        );
        require!(
            proposal.intent_deadline.0 > env::block_timestamp(),
            "intent_deadline in the past"
        );

        // Slippage bound: min_out must be within max_slippage of amount_in (1:1 placeholder units).
        // Real quote verification happens off-chain; contract enforces the numeric floor ratio.
        if proposal.amount_in.0 > 0 {
            let min_ratio_bps = 10_000u128.saturating_sub(self.limits.max_slippage_bps as u128);
            let floor = proposal
                .amount_in
                .0
                .saturating_mul(min_ratio_bps)
                / 10_000;
            require!(
                proposal.min_amount_out.0 >= floor,
                "min_amount_out below slippage bound"
            );
        }

        Self::normalize_commitment(&proposal.payload_commitment);
    }

    fn bump_daily_turnover(&mut self, amount: u128) {
        let day = env::block_timestamp() / 86_400_000_000_000;
        if day != self.daily_turnover_day {
            self.daily_turnover_day = day;
            self.daily_turnover = 0;
        }
        let next = self
            .daily_turnover
            .checked_add(amount)
            .expect("turnover overflow");
        require!(
            next <= self.limits.daily_turnover_limit.0,
            "daily turnover exceeded"
        );
        self.daily_turnover = next;
    }

    fn release_reservation(&mut self, amount: u128) {
        self.reserved_pending_exposure = self.reserved_pending_exposure.saturating_sub(amount);
    }

    fn count_pending(&self) -> (u64, u64) {
        let mut active_signing = 0u64;
        let mut unresolved = 0u64;
        for (_id, op) in self.pending.iter() {
            if op.signing_state == SigningState::Signing {
                active_signing += 1;
            }
            let terminal = matches!(
                op.settlement_state,
                SettlementState::Success
                    | SettlementState::Refunded
                    | SettlementState::Failed
                    | SettlementState::Expired
                    | SettlementState::Reconciled
            );
            let rolled = op.signing_state == SigningState::RolledBack;
            if !terminal && !rolled {
                unresolved += 1;
            }
        }
        (active_signing, unresolved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, AccountId};

    fn owner() -> AccountId {
        accounts(0)
    }

    fn agent() -> AccountId {
        accounts(1)
    }

    fn mpc() -> AccountId {
        "v1.signer-prod.testnet".parse().unwrap()
    }

    fn limits() -> PolicyLimits {
        PolicyLimits {
            max_trade_value: U128(25),
            daily_turnover_limit: U128(100),
            max_pending_exposure: U128(25),
            max_slippage_bps: 100,
            allowed_assets: vec![
                "USDC".into(),
                "NEAR".into(),
                "ETH".into(),
                "nep141:usdc.tidepool-sandbox.testnet".into(),
                "native:near".into(),
                "eip155:11155111:0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2".into(),
            ],
            allowed_destinations: vec![
                "intents.near".into(),
                "bob.testnet".into(),
                "0x0000000000000000000000000000000000000001".into(),
            ],
            // far future (ns)
            valid_until: U64(u64::MAX / 2),
            token_scope: "allowlist".into(),
            allowed_chains: vec![
                "near".into(),
                "eip155:11155111".into(),
                "eip155:1".into(),
                "eip155:42161".into(),
                "eip155:8453".into(),
            ],
            allowed_venues: vec!["near_intents_1click".into()],
            max_gas_budget: U128(u128::MAX / 4),
        }
    }

    fn context(predecessor: AccountId, deposit: u128) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(accounts(2))
            .predecessor_account_id(predecessor)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(1_000_000_000);
        b
    }

    fn commitment() -> String {
        "521da91dc9bddb625bd0679d9e735def558761a34653624f5954f44bce6443a9".into()
    }

    fn proposal(id: &str, amount: u128) -> TradeProposal {
        TradeProposal {
            operation_id: id.into(),
            amount_in: U128(amount),
            asset_in: "USDC".into(),
            asset_out: "NEAR".into(),
            destination: "intents.near".into(),
            min_amount_out: U128(amount * 99 / 100),
            intent_deadline: U64(9_000_000_000),
            payload_commitment: commitment(),
        }
    }

    fn deploy() -> PolicyContract {
        testing_env!(context(owner(), 0).build());
        let mut c = PolicyContract::new(
            owner(),
            agent(),
            mpc(),
            "alpha".into(),
            "verifier.tidepool-sandbox.testnet".into(),
            limits(),
        );
        // new() is paused=true (inert). Unpause only for tests that exercise
        // an active mandate; pause/adversarial tests call new() directly.
        assert!(c.get_paused(), "new() must start paused");
        c.unpause();
        c.set_intents_signer_id("0xca67c1bb3fd69857e5edaf6aa1c65371bf46a464".into());
        c
    }

    fn deploy_inert() -> PolicyContract {
        testing_env!(context(owner(), 0).build());
        let mut c = PolicyContract::new(
            owner(),
            agent(),
            mpc(),
            "alpha".into(),
            "verifier.tidepool-sandbox.testnet".into(),
            limits(),
        );
        c.set_intents_signer_id("0xca67c1bb3fd69857e5edaf6aa1c65371bf46a464".into());
        assert!(c.get_paused());
        assert!(!c.get_revocation_status().revoked);
        c
    }

    #[test]
    fn propose_trade_reserves_exposure() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        let op = c.propose_trade(proposal("op-1", 10));
        assert_eq!(op.signing_state, SigningState::Reserved);
        assert_eq!(c.get_reserved_pending_exposure().0, 10);
    }

    #[test]
    #[should_panic(expected = "exceeds max_trade_value")]
    fn reject_over_max_trade() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        c.propose_trade(proposal("op-1", 26));
    }

    #[test]
    #[should_panic(expected = "aggregate pending exposure exceeded")]
    fn pending_exposure_blocks_second_trade() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        c.propose_trade(proposal("op-1", 20));
        c.propose_trade(proposal("op-2", 10));
    }

    #[test]
    fn pending_exposure_allows_within_cap() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        c.propose_trade(proposal("op-1", 10));
        c.propose_trade(proposal("op-2", 15));
        assert_eq!(c.get_reserved_pending_exposure().0, 25);
    }

    #[test]
    #[should_panic(expected = "revoked")]
    fn revoke_blocks_propose_trade() {
        let mut c = deploy();
        testing_env!(context(owner(), 0).build());
        c.revoke();
        testing_env!(context(agent(), 0).build());
        c.propose_trade(proposal("op-1", 10));
    }

    #[test]
    #[should_panic(expected = "revoked")]
    fn revoke_blocks_request_signature() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        c.propose_trade(proposal("op-1", 10));

        testing_env!(context(owner(), 0).build());
        c.revoke();

        testing_env!(context(agent(), 1).build());
        let _ = c.request_signature("op-1".into());
    }

    #[test]
    fn revocation_status_not_fully_revoked_while_pending() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        c.propose_trade(proposal("op-1", 10));
        testing_env!(context(owner(), 0).build());
        c.revoke();
        let status = c.get_revocation_status();
        assert!(status.revoked);
        assert!(!status.fully_revoked);
        assert_eq!(status.unresolved_pending, 1);
    }

    #[test]
    fn callback_after_revoke_does_not_release_signature() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        c.propose_trade(proposal("op-1", 10));

        // Simulate moving to Signing without live MPC.
        let mut op = c.pending.get(&"op-1".to_string()).cloned().unwrap();
        let epoch = op.epoch;
        op.signing_state = SigningState::Signing;
        c.pending.insert("op-1".to_string(), op.clone());

        testing_env!(context(owner(), 0).build());
        c.revoke();

        testing_env!(context(accounts(2), 0).build()); // private callback from self
        let sig = SignatureResponse::Secp256k1 {
            big_r: AffinePoint {
                affine_point: "00".repeat(33),
            },
            s: Scalar {
                scalar: "11".repeat(32),
            },
            recovery_id: 0,
        };
        let out = c.on_signature("op-1".into(), epoch, Ok(sig));
        assert!(out.is_none(), "must not release signature after revoke");
        let op = c.get_pending("op-1".into()).unwrap();
        assert_eq!(op.signing_state, SigningState::RolledBack);
    }

    #[test]
    fn derivation_path_is_stable_portfolio() {
        let mut c = deploy();
        assert_eq!(c.get_derivation_path(), "trading/v1/portfolio/alpha");
        testing_env!(context(owner(), 0).build());
        c.revoke();
        // Epoch advanced but path must NOT change.
        assert_eq!(c.get_mandate_epoch(), 2);
        assert_eq!(c.get_derivation_path(), "trading/v1/portfolio/alpha");
    }

    #[test]
    fn eip191_digest_matches_known_vector_shape() {
        let c = deploy();
        let payload = "{\"signer_id\":\"0xca67c1bb3fd69857e5edaf6aa1c65371bf46a464\"}";
        let d = c.eip191_digest(payload.into());
        assert_eq!(d.len(), 64);
    }

    #[test]
    fn propose_intent_reserves_and_binds_digest() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        let payload = serde_json::json!({
            "signer_id": "0xca67c1bb3fd69857e5edaf6aa1c65371bf46a464",
            "verifying_contract": "verifier.tidepool-sandbox.testnet",
            "deadline": "2030-01-01T00:00:00.000Z",
            "nonce": "Vij2xgAlKBKzwGNqwogWQxiy87p9jW5Omfg+L9bXBDw=",
            "intents": [{
                "intent": "transfer",
                "receiver_id": "bob.testnet",
                "tokens": { "nep141:usdc.tidepool-sandbox.testnet": "10" }
            }]
        })
        .to_string();
        let op = c.propose_intent("op-i1".into(), payload.clone(), 1);
        assert_eq!(op.signing_state, SigningState::Reserved);
        assert_eq!(op.payload_commitment, c.eip191_digest(payload));
        assert_eq!(c.get_reserved_pending_exposure().0, 10);
    }

    #[test]
    #[should_panic(expected = "signer_id mismatch")]
    fn propose_intent_rejects_wrong_signer() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        let payload = serde_json::json!({
            "signer_id": "0x0000000000000000000000000000000000000001",
            "verifying_contract": "verifier.tidepool-sandbox.testnet",
            "deadline": "2030-01-01T00:00:00.000Z",
            "nonce": "Vij2xgAlKBKzwGNqwogWQxiy87p9jW5Omfg+L9bXBDw=",
            "intents": [{
                "intent": "transfer",
                "receiver_id": "bob.testnet",
                "tokens": { "nep141:usdc.tidepool-sandbox.testnet": "10" }
            }]
        })
        .to_string();
        c.propose_intent("op-bad".into(), payload, 1);
    }

    #[test]
    #[should_panic(expected = "destination not allowed")]
    fn propose_intent_rejects_wrong_recipient() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        let payload = serde_json::json!({
            "signer_id": "0xca67c1bb3fd69857e5edaf6aa1c65371bf46a464",
            "verifying_contract": "verifier.tidepool-sandbox.testnet",
            "deadline": "2030-01-01T00:00:00.000Z",
            "nonce": "aaa=",
            "intents": [{
                "intent": "transfer",
                "receiver_id": "eve.testnet",
                "tokens": { "nep141:usdc.tidepool-sandbox.testnet": "10" }
            }]
        })
        .to_string();
        c.propose_intent("op-eve".into(), payload, 1);
    }

    #[test]
    fn unrevoke_reactivates_mandate() {
        let mut c = deploy();
        testing_env!(context(owner(), 0).build());
        c.revoke();
        assert!(c.get_revocation_status().revoked);
        let epoch_after_revoke = c.get_mandate_epoch();
        c.unrevoke();
        let status = c.get_revocation_status();
        assert!(!status.revoked);
        assert_eq!(c.get_mandate_epoch(), epoch_after_revoke + 1);
        testing_env!(context(agent(), 0).build());
        let _ = c.propose_trade(proposal("op-after-unrevoke", 1));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn unauthorized_cannot_revoke() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        c.revoke();
    }

    #[test]
    #[should_panic(expected = "asset_in not allowed")]
    fn reject_disallowed_asset() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        let mut p = proposal("op-1", 10);
        p.asset_in = "DOGE".into();
        c.propose_trade(p);
    }

    #[test]
    fn mark_settlement_releases_exposure_once() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        c.propose_trade(proposal("op-1", 10));
        assert_eq!(c.get_reserved_pending_exposure().0, 10);

        testing_env!(context(owner(), 0).build());
        c.mark_settlement("op-1".into(), SettlementState::Failed);
        assert_eq!(c.get_reserved_pending_exposure().0, 0);

        let status = c.get_revocation_status();
        assert_eq!(status.unresolved_pending, 0);
    }

    #[test]
    fn any_eligible_token_permits_chain_member_not_arbitrary() {
        let mut c = deploy();
        testing_env!(context(owner(), 0).build());
        let mut lim = limits();
        lim.token_scope = "any_eligible_token".into();
        lim.allowed_assets = vec![]; // dynamic — not an open calldata grant
        lim.allowed_chains = vec!["near".into()];
        c.set_policy(lim, "h".into(), "s".into());
        testing_env!(context(agent(), 0).build());
        let mut p = proposal("op-any", 5);
        p.asset_in = "nep141:unknown-but-near.near".into();
        p.asset_out = "native:near".into();
        let _ = c.propose_trade(p);
    }

    #[test]
    #[should_panic(expected = "asset_in not allowed")]
    fn any_eligible_token_rejects_wrong_chain() {
        let mut c = deploy();
        testing_env!(context(owner(), 0).build());
        let mut lim = limits();
        lim.token_scope = "any_eligible_token".into();
        lim.allowed_assets = vec![];
        lim.allowed_chains = vec!["near".into()];
        c.set_policy(lim, "h".into(), "s".into());
        testing_env!(context(agent(), 0).build());
        let mut p = proposal("op-bad-chain", 5);
        p.asset_in = "eip155:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".into();
        p.asset_out = "native:near".into();
        c.propose_trade(p);
    }

    /// Fixed ed25519 seed=0x07… (see packages/intents-codec quote-auth helpers).
    const TEST_QUOTE_PK: &str = "ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
    const TEST_QUOTE_SIG: &str =
        "ed25519:2Ptx5KRAipkVAMcxCpTQhud5j3YGgKtn9jfdXHbQg7P1PCYMdFVqSjEzHNG8URrtrJbYxJSfQzfSM5fez87ca3Qy";

    fn quoted_attestation() -> QuoteAttestation {
        QuoteAttestation {
            deposit_address: "0x1111111111111111111111111111111111111111".into(),
            amount_in: U128(10),
            asset_in: "eip155:11155111:0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2".into(),
            asset_out: "native:near".into(),
            min_amount_out: U128(10),
            quote_deadline_ns: U64(9_000_000_000),
            token_contract: "0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2".into(),
            chain_id: U64(11_155_111),
            recipient: "0x0000000000000000000000000000000000000001".into(),
            refund_to: "0x0000000000000000000000000000000000000001".into(),
            correlation_id: "corr-test-1".into(),
            quote_hash: "qh-test-1".into(),
            max_gas_price: U128(1_000_000_000),
            gas_limit: U64(100_000),
        }
    }

    fn quoted_tx() -> EvmTxParams {
        EvmTxParams {
            to: "0x1111111111111111111111111111111111111111".into(),
            token_contract: "0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2".into(),
            amount: U128(10),
            chain_id: U64(11_155_111),
            gas_limit: U64(100_000),
            gas_price: U128(1_000_000_000),
            nonce: U64(7),
        }
    }

    fn deploy_with_quote_signer() -> PolicyContract {
        let mut c = deploy();
        testing_env!(context(owner(), 0).build());
        c.set_trusted_quote_signer(TEST_QUOTE_PK.into());
        c
    }

    #[test]
    fn quoted_evm_binds_digest_to_deposit_transfer() {
        let mut c = deploy_with_quote_signer();
        testing_env!(context(agent(), 0).build());
        let op = c.propose_quoted_evm_transfer(
            "op-q1".into(),
            quoted_attestation(),
            TEST_QUOTE_SIG.into(),
            TEST_QUOTE_PK.into(),
            quoted_tx(),
            1,
        );
        assert_eq!(op.signing_state, SigningState::Reserved);
        assert_eq!(op.destination, "0x1111111111111111111111111111111111111111");
        assert_eq!(op.epoch, 1);
        // Digest is contract-computed EIP-155 of ERC-20 transfer(deposit, amount) —
        // agent cannot supply an alternate payload_commitment.
        let token = evm_auth::parse_hex_address(&quoted_tx().token_contract);
        let to = evm_auth::parse_hex_address(&quoted_tx().to);
        let data = evm_auth::erc20_transfer_data(&to, 10);
        let digest = evm_auth::eip155_unsigned_digest(
            7,
            1_000_000_000,
            100_000,
            &token,
            0,
            &data,
            11_155_111,
        );
        assert_eq!(op.payload_commitment, evm_auth::digest_hex(&digest));
        // request_signature reads only stored commitment (no agent payload arg).
        let stored = c.get_pending("op-q1".into()).unwrap();
        assert_eq!(stored.payload_commitment, op.payload_commitment);
    }

    #[test]
    #[should_panic(expected = "tx.to != attested deposit")]
    fn quoted_evm_rejects_attacker_recipient_substitution() {
        let mut c = deploy_with_quote_signer();
        testing_env!(context(agent(), 0).build());
        let mut tx = quoted_tx();
        // Malicious agent swaps ERC-20 transfer recipient after quote approval.
        tx.to = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef".into();
        let _ = c.propose_quoted_evm_transfer(
            "op-evil".into(),
            quoted_attestation(),
            TEST_QUOTE_SIG.into(),
            TEST_QUOTE_PK.into(),
            tx,
            1,
        );
    }

    #[test]
    #[should_panic(expected = "recipient not allowed")]
    fn quoted_evm_rejects_non_allowlisted_recipient() {
        let mut c = deploy_with_quote_signer();
        testing_env!(context(agent(), 0).build());
        let mut att = quoted_attestation();
        att.recipient = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef".into();
        // Direct contract call: allowlist blocks before signature even matters.
        let _ = c.propose_quoted_evm_transfer(
            "op-resub".into(),
            att,
            TEST_QUOTE_SIG.into(),
            TEST_QUOTE_PK.into(),
            quoted_tx(),
            1,
        );
    }

    #[test]
    #[should_panic(expected = "invalid quote attestation signature")]
    fn quoted_evm_rejects_allowlisted_recipient_without_resign() {
        let mut c = deploy_with_quote_signer();
        testing_env!(context(owner(), 0).build());
        let mut lim = limits();
        // Attacker address is allowlisted but attestation still signed for original recipient.
        lim.allowed_destinations
            .push("0x0000000000000000000000000000000000000002".into());
        c.set_policy(lim, "h".into(), "s".into());
        testing_env!(context(agent(), 0).build());
        let mut att = quoted_attestation();
        att.recipient = "0x0000000000000000000000000000000000000002".into();
        let _ = c.propose_quoted_evm_transfer(
            "op-resign".into(),
            att,
            TEST_QUOTE_SIG.into(),
            TEST_QUOTE_PK.into(),
            quoted_tx(),
            2, // set_policy advanced epoch
        );
    }

    #[test]
    #[should_panic(expected = "any_eligible_token_not_safe_for_evm_sign")]
    fn quoted_evm_blocks_any_eligible_token_mode() {
        let mut c = deploy_with_quote_signer();
        testing_env!(context(owner(), 0).build());
        let mut lim = limits();
        lim.token_scope = "any_eligible_token".into();
        lim.allowed_assets = vec![];
        c.set_policy(lim, "h".into(), "s".into());
        testing_env!(context(agent(), 0).build());
        let _ = c.propose_quoted_evm_transfer(
            "op-any-evm".into(),
            quoted_attestation(),
            TEST_QUOTE_SIG.into(),
            TEST_QUOTE_PK.into(),
            quoted_tx(),
            2,
        );
    }

    #[test]
    #[should_panic(expected = "exceeds max_gas_budget")]
    fn quoted_evm_enforces_max_gas_budget() {
        let mut c = deploy_with_quote_signer();
        testing_env!(context(owner(), 0).build());
        let mut lim = limits();
        lim.max_gas_budget = U128(1); // far below gas_price * gas_limit
        c.set_policy(lim, "h".into(), "s".into());
        testing_env!(context(agent(), 0).build());
        let _ = c.propose_quoted_evm_transfer(
            "op-gas".into(),
            quoted_attestation(),
            TEST_QUOTE_SIG.into(),
            TEST_QUOTE_PK.into(),
            quoted_tx(),
            2,
        );
    }

    #[test]
    #[should_panic(expected = "max_gas_budget required")]
    fn set_policy_rejects_zero_max_gas_budget() {
        let mut c = deploy();
        testing_env!(context(owner(), 0).build());
        let mut lim = limits();
        lim.max_gas_budget = U128(0);
        c.set_policy(lim, "h".into(), "s".into());
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn unauthorized_set_policy_rejected() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        c.set_policy(limits(), "h".into(), "s".into());
    }

    #[test]
    #[should_panic(expected = "stale mandate epoch")]
    fn quoted_evm_rejects_after_policy_epoch_change() {
        let mut c = deploy_with_quote_signer();
        testing_env!(context(owner(), 0).build());
        // Bump epoch via set_policy while agent still presents epoch 1.
        c.set_policy(limits(), "h2".into(), "s2".into());
        testing_env!(context(agent(), 0).build());
        let _ = c.propose_quoted_evm_transfer(
            "op-stale".into(),
            quoted_attestation(),
            TEST_QUOTE_SIG.into(),
            TEST_QUOTE_PK.into(),
            quoted_tx(),
            1, // stale
        );
    }

    #[test]
    #[should_panic(expected = "tx.gas_price out of attested bounds")]
    fn quoted_evm_rejects_excessive_gas_price() {
        let mut c = deploy_with_quote_signer();
        testing_env!(context(agent(), 0).build());
        let mut tx = quoted_tx();
        tx.gas_price = U128(9_000_000_000); // > attested max 1e9
        let _ = c.propose_quoted_evm_transfer(
            "op-gasp".into(),
            quoted_attestation(),
            TEST_QUOTE_SIG.into(),
            TEST_QUOTE_PK.into(),
            tx,
            1,
        );
    }

    #[test]
    #[should_panic(expected = "tx.gas_limit != attested")]
    fn quoted_evm_rejects_gas_limit_mismatch() {
        let mut c = deploy_with_quote_signer();
        testing_env!(context(agent(), 0).build());
        let mut tx = quoted_tx();
        tx.gas_limit = U64(9_000_000);
        let _ = c.propose_quoted_evm_transfer(
            "op-gasl".into(),
            quoted_attestation(),
            TEST_QUOTE_SIG.into(),
            TEST_QUOTE_PK.into(),
            tx,
            1,
        );
    }

    #[test]
    #[should_panic(expected = "evm destinations require propose_quoted_evm_transfer")]
    fn propose_trade_cannot_bypass_quoted_evm_path() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        let mut p = proposal("op-bypass", 10);
        p.destination = "0x1111111111111111111111111111111111111111".into();
        c.propose_trade(p);
    }

    #[test]
    #[should_panic(expected = "attestation already used")]
    fn quoted_evm_attestation_replay_blocked() {
        let mut c = deploy_with_quote_signer();
        testing_env!(context(agent(), 0).build());
        let _ = c.propose_quoted_evm_transfer(
            "op-r1".into(),
            quoted_attestation(),
            TEST_QUOTE_SIG.into(),
            TEST_QUOTE_PK.into(),
            quoted_tx(),
            1,
        );
        let mut tx2 = quoted_tx();
        tx2.nonce = U64(8);
        let _ = c.propose_quoted_evm_transfer(
            "op-r2".into(),
            quoted_attestation(),
            TEST_QUOTE_SIG.into(),
            TEST_QUOTE_PK.into(),
            tx2,
            1,
        );
    }

    // ─── Inert-by-default / pause adversarial (direct contract calls) ─────

    #[test]
    fn new_initializes_paused_not_revoked() {
        let c = deploy_inert();
        assert!(c.get_paused());
        assert!(!c.get_revocation_status().revoked);
        assert_eq!(c.get_mandate_epoch(), 1);
    }

    #[test]
    #[should_panic(expected = "paused")]
    fn paused_blocks_agent_propose_trade_direct_call() {
        let mut c = deploy_inert();
        testing_env!(context(agent(), 0).build());
        c.propose_trade(proposal("op-paused", 1));
    }

    #[test]
    #[should_panic(expected = "paused")]
    fn paused_blocks_agent_propose_intent_direct_call() {
        let mut c = deploy_inert();
        testing_env!(context(agent(), 0).build());
        let payload = serde_json::json!({
            "signer_id": "0xca67c1bb3fd69857e5edaf6aa1c65371bf46a464",
            "deadline": "9000000000",
            "intents": [{
                "intent": "token_diff",
                "diff": {
                    "nep141:usdc.tidepool-sandbox.testnet": "-10",
                    "nep141:wnear.tidepool-sandbox.testnet": "1"
                }
            }],
            "receipts": [{
                "receiver_id": "alice.near",
                "amount": "0",
                "msg": "",
                "tokens": { "nep141:usdc.tidepool-sandbox.testnet": "10" }
            }]
        })
        .to_string();
        c.propose_intent("op-paused-intent".into(), payload, 1);
    }

    #[test]
    #[should_panic(expected = "paused")]
    fn paused_blocks_agent_propose_quoted_evm_direct_call() {
        let mut c = deploy_inert();
        testing_env!(context(owner(), 0).build());
        c.set_trusted_quote_signer(TEST_QUOTE_PK.into());
        testing_env!(context(agent(), 0).build());
        let _ = c.propose_quoted_evm_transfer(
            "op-paused-q".into(),
            quoted_attestation(),
            TEST_QUOTE_SIG.into(),
            TEST_QUOTE_PK.into(),
            quoted_tx(),
            1,
        );
    }

    #[test]
    #[should_panic(expected = "paused")]
    fn paused_blocks_request_signature_even_if_op_preexisted() {
        // Active → propose → owner pause → agent cannot request_signature.
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        c.propose_trade(proposal("op-pre", 10));
        testing_env!(context(owner(), 0).build());
        c.pause();
        assert!(c.get_paused());
        testing_env!(context(agent(), 1).build());
        let _ = c.request_signature("op-pre".into());
    }

    /// FunctionCall-limited keys cannot attach deposit; request_signature needs ≥1 yocto.
    /// Proves Option A (agent FullAccess) is required for real MPC completion.
    #[test]
    #[should_panic(expected = "attach at least 1 yoctoNEAR for MPC sign")]
    fn request_signature_requires_one_yocto_deposit() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        c.propose_trade(proposal("op-yocto", 10));
        // Same agent predecessor, but zero attached deposit — must fail closed.
        testing_env!(context(agent(), 0).build());
        let _ = c.request_signature("op-yocto".into());
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn agent_cannot_unpause() {
        let mut c = deploy_inert();
        testing_env!(context(agent(), 0).build());
        c.unpause();
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn agent_cannot_pause() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        c.pause();
    }

    #[test]
    fn owner_unpause_enables_propose_then_pause_blocks_again() {
        let mut c = deploy_inert();
        testing_env!(context(owner(), 0).build());
        c.unpause();
        assert!(!c.get_paused());
        testing_env!(context(agent(), 0).build());
        let op = c.propose_trade(proposal("op-after-unpause", 5));
        assert_eq!(op.signing_state, SigningState::Reserved);
        testing_env!(context(owner(), 0).build());
        c.pause();
        assert!(c.get_paused());
    }

    #[test]
    #[should_panic(expected = "paused")]
    fn owner_pause_blocks_subsequent_propose() {
        let mut c = deploy();
        testing_env!(context(owner(), 0).build());
        c.pause();
        testing_env!(context(agent(), 0).build());
        c.propose_trade(proposal("op-re-paused", 1));
    }

    #[test]
    #[should_panic(expected = "cannot unpause while revoked")]
    fn cannot_unpause_while_revoked_without_unrevoke() {
        let mut c = deploy();
        testing_env!(context(owner(), 0).build());
        c.revoke();
        assert!(c.get_revocation_status().revoked);
        assert!(c.get_paused());
        c.unpause();
    }

    #[test]
    fn enforce_autonomous_default_off_allows_canary_propose() {
        let mut c = deploy();
        assert!(!c.get_enforce_autonomous_on_agent());
        assert!(!c.get_autonomous_trading());
        testing_env!(context(agent(), 0).build());
        let op = c.propose_trade(proposal("op-canary-ok", 5));
        assert_eq!(op.signing_state, SigningState::Reserved);
    }

    #[test]
    #[should_panic(expected = "autonomous_trading_required")]
    fn enforce_autonomous_on_blocks_propose_without_flag() {
        let mut c = deploy();
        testing_env!(context(owner(), 0).build());
        c.set_enforce_autonomous_on_agent(true);
        assert!(c.get_enforce_autonomous_on_agent());
        assert!(!c.get_autonomous_trading());
        testing_env!(context(agent(), 0).build());
        c.propose_trade(proposal("op-auto-blocked", 5));
    }

    #[test]
    fn enforce_autonomous_on_allows_propose_when_autonomous_enabled() {
        let mut c = deploy();
        testing_env!(context(owner(), 0).build());
        c.set_enforce_autonomous_on_agent(true);
        c.set_autonomous_trading(true);
        testing_env!(context(agent(), 0).build());
        let op = c.propose_trade(proposal("op-auto-ok", 5));
        assert_eq!(op.signing_state, SigningState::Reserved);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn agent_cannot_set_enforce_autonomous_on_agent() {
        let mut c = deploy();
        testing_env!(context(agent(), 0).build());
        c.set_enforce_autonomous_on_agent(true);
    }
}
