//! On-chain EIP-155 digest + quote attestation helpers (Gate F1+).

use near_sdk::{env, require};

/// QUOTE_AUTH_V2 — binds deposit, economics, recipient/refund, quote identity, gas bounds.
/// Must match packages/intents-codec/quote-auth.mjs.
pub fn attestation_message_v2(
    deposit_address: &str,
    amount_in: u128,
    asset_in: &str,
    asset_out: &str,
    min_amount_out: u128,
    quote_deadline_ns: u64,
    token_contract: &str,
    chain_id: u64,
    recipient: &str,
    refund_to: &str,
    correlation_id: &str,
    quote_hash: &str,
    max_gas_price: u128,
    gas_limit: u64,
) -> Vec<u8> {
    let s = format!(
        "QUOTE_AUTH_V2\ndeposit={}\namount_in={}\nasset_in={}\nasset_out={}\nmin_out={}\ndeadline_ns={}\ntoken={}\nchain_id={}\nrecipient={}\nrefund_to={}\ncorrelation_id={}\nquote_hash={}\nmax_gas_price={}\ngas_limit={}\n",
        deposit_address.to_lowercase(),
        amount_in,
        asset_in,
        asset_out,
        min_amount_out,
        quote_deadline_ns,
        token_contract.to_lowercase(),
        chain_id,
        recipient.to_lowercase(),
        refund_to.to_lowercase(),
        correlation_id,
        quote_hash,
        max_gas_price,
        gas_limit
    );
    s.into_bytes()
}

pub fn attestation_id(msg: &[u8]) -> [u8; 32] {
    env::sha256_array(msg)
}

pub fn parse_hex_address(addr: &str) -> [u8; 20] {
    let a = addr.trim().trim_start_matches("0x").to_lowercase();
    require!(a.len() == 40 && a.bytes().all(|b| b.is_ascii_hexdigit()), "bad address");
    let bytes = hex::decode(&a).expect("hex");
    let mut out = [0u8; 20];
    out.copy_from_slice(&bytes);
    out
}

fn rlp_encode_bytes(data: &[u8]) -> Vec<u8> {
    if data.len() == 1 && data[0] < 0x80 {
        return data.to_vec();
    }
    if data.len() <= 55 {
        let mut out = Vec::with_capacity(1 + data.len());
        out.push(0x80 + data.len() as u8);
        out.extend_from_slice(data);
        return out;
    }
    let len_bytes = encode_min_be(data.len() as u64);
    let mut out = Vec::with_capacity(1 + len_bytes.len() + data.len());
    out.push(0xb7 + len_bytes.len() as u8);
    out.extend_from_slice(&len_bytes);
    out.extend_from_slice(data);
    out
}

fn rlp_encode_list(items: &[Vec<u8>]) -> Vec<u8> {
    let mut payload = Vec::new();
    for it in items {
        payload.extend_from_slice(it);
    }
    if payload.len() <= 55 {
        let mut out = Vec::with_capacity(1 + payload.len());
        out.push(0xc0 + payload.len() as u8);
        out.extend_from_slice(&payload);
        return out;
    }
    let len_bytes = encode_min_be(payload.len() as u64);
    let mut out = Vec::with_capacity(1 + len_bytes.len() + payload.len());
    out.push(0xf7 + len_bytes.len() as u8);
    out.extend_from_slice(&len_bytes);
    out.extend_from_slice(&payload);
    out
}

fn encode_min_be(n: u64) -> Vec<u8> {
    if n == 0 {
        return Vec::new();
    }
    let mut bytes = n.to_be_bytes().to_vec();
    while bytes.first() == Some(&0) {
        bytes.remove(0);
    }
    bytes
}

fn rlp_quantity(n: u128) -> Vec<u8> {
    rlp_encode_bytes(&encode_min_be_u128(n))
}

fn encode_min_be_u128(n: u128) -> Vec<u8> {
    if n == 0 {
        return Vec::new();
    }
    let mut bytes = n.to_be_bytes().to_vec();
    while bytes.first() == Some(&0) {
        bytes.remove(0);
    }
    bytes
}

pub fn erc20_transfer_data(to: &[u8; 20], amount: u128) -> Vec<u8> {
    let mut data = Vec::with_capacity(4 + 32 + 32);
    data.extend_from_slice(&hex::decode("a9059cbb").unwrap());
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(to);
    let mut amt = [0u8; 32];
    let be = amount.to_be_bytes();
    amt[16..].copy_from_slice(&be);
    data.extend_from_slice(&amt);
    data
}

pub fn eip155_unsigned_digest(
    nonce: u64,
    gas_price: u128,
    gas_limit: u64,
    to: &[u8; 20],
    value: u128,
    data: &[u8],
    chain_id: u64,
) -> [u8; 32] {
    let items = [
        rlp_quantity(nonce as u128),
        rlp_quantity(gas_price),
        rlp_quantity(gas_limit as u128),
        rlp_encode_bytes(to),
        rlp_quantity(value),
        rlp_encode_bytes(data),
        rlp_quantity(chain_id as u128),
        rlp_encode_bytes(&[]),
        rlp_encode_bytes(&[]),
    ];
    let encoded = rlp_encode_list(&items);
    env::keccak256_array(&encoded)
}

pub fn digest_hex(digest: &[u8; 32]) -> String {
    hex::encode(digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attestation_v2_stable() {
        let m = attestation_message_v2(
            "0xABC",
            1000000,
            "in",
            "out",
            1,
            42,
            "0xDEF",
            11155111,
            "0xREC",
            "0xREF",
            "corr-1",
            "qhash",
            1_000_000_000,
            250000,
        );
        let s = String::from_utf8(m).unwrap();
        assert!(s.starts_with("QUOTE_AUTH_V2\n"));
        assert!(s.contains("recipient=0xrec\n"));
        assert!(s.contains("correlation_id=corr-1\n"));
    }
}
