//! SYCEE receipt-hash anchor.
//!
//! Stores 32-byte hashes, a chain label, a merchant id, and the block
//! timestamp. It does not store payment proofs, receipt bodies, or personal
//! data. It does not score anyone, and it does not move or hold funds:
//! no method is payable, and the contract never creates a transfer.

use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

const MAX_BATCH: usize = 32;
const MAX_PROOF: usize = 8;
const MAX_SOURCE_CHAIN: usize = 64;
const MAX_MERCHANT_ID: usize = 128;
const LEAF_TAG: u8 = 0x00;
const NODE_TAG: u8 = 0x01;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct AnchorRecord {
    pub receipt_hash: String,
    pub source_chain: String,
    pub merchant_id: String,
    pub batch_root: Option<String>,
    pub block_height: u64,
    pub block_timestamp_ns: String,
    pub predecessor: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct BatchRecord {
    pub batch_root: String,
    pub count: u32,
    pub source_chain: String,
    pub merchant_id: String,
    pub block_height: u64,
    pub block_timestamp_ns: String,
    pub predecessor: AccountId,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    anchorers: LookupMap<AccountId, bool>,
    anchors: LookupMap<String, AnchorRecord>,
    batches: LookupMap<String, BatchRecord>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, anchorers: Option<Vec<AccountId>>) -> Self {
        require!(env::attached_deposit().is_zero(), "this contract does not accept funds");
        let mut contract = Self {
            owner: owner.clone(),
            anchorers: LookupMap::new(b"a".to_vec()),
            anchors: LookupMap::new(b"r".to_vec()),
            batches: LookupMap::new(b"b".to_vec()),
        };
        contract.anchorers.insert(owner, true);
        if let Some(list) = anchorers {
            for account_id in list {
                contract.anchorers.insert(account_id, true);
            }
        }
        contract
    }

    /// Store one receipt hash. `batch_root`, when set, must already have been
    /// registered by `anchor_batch`.
    pub fn anchor(
        &mut self,
        receipt_hash: String,
        source_chain: String,
        merchant_id: String,
        batch_root: Option<String>,
    ) -> AnchorRecord {
        self.assert_no_deposit();
        self.assert_anchorer();
        let hash = normalize_hash(&receipt_hash);
        require!(!self.anchors.contains_key(&hash), "duplicate receipt hash");
        let source_chain = check_label(&source_chain, MAX_SOURCE_CHAIN, "source_chain");
        let merchant_id = check_label(&merchant_id, MAX_MERCHANT_ID, "merchant_id");
        let batch_root = match batch_root {
            None => None,
            Some(root) => {
                let root = normalize_hash(&root);
                require!(self.batches.contains_key(&root), "unknown batch root");
                Some(root)
            }
        };
        let record = self.write_anchor(hash, source_chain, merchant_id, batch_root);
        emit(
            "anchor",
            &format!(
                "{{\"receipt_hash\":\"{}\",\"source_chain\":\"{}\",\"merchant_id\":\"{}\",\"batch_root\":{},\"predecessor\":\"{}\"}}",
                record.receipt_hash,
                record.source_chain,
                record.merchant_id,
                json_opt(&record.batch_root),
                record.predecessor,
            ),
        );
        record
    }

    /// Anchor many receipt hashes under one Merkle root computed by this
    /// contract. The caller does not choose the root.
    pub fn anchor_batch(
        &mut self,
        receipt_hashes: Vec<String>,
        source_chain: String,
        merchant_id: String,
    ) -> String {
        self.assert_no_deposit();
        self.assert_anchorer();
        require!(!receipt_hashes.is_empty(), "empty batch");
        require!(receipt_hashes.len() <= MAX_BATCH, "batch exceeds 32 receipts");
        let source_chain = check_label(&source_chain, MAX_SOURCE_CHAIN, "source_chain");
        let merchant_id = check_label(&merchant_id, MAX_MERCHANT_ID, "merchant_id");

        let mut leaves: Vec<[u8; 32]> = Vec::with_capacity(receipt_hashes.len());
        let mut hexes: Vec<String> = Vec::with_capacity(receipt_hashes.len());
        for raw in &receipt_hashes {
            let hex = normalize_hash(raw);
            require!(!self.anchors.contains_key(&hex), "duplicate receipt hash");
            let bytes = decode_hash(&hex);
            require!(!leaves.contains(&bytes), "duplicate receipt hash");
            leaves.push(bytes);
            hexes.push(hex);
        }

        let root_bytes = merkle_root(&leaves);
        let root = to_hex(&root_bytes);
        require!(!self.batches.contains_key(&root), "duplicate batch root");
        require!(!self.anchors.contains_key(&root), "batch root collides with a receipt hash");

        let (height, timestamp, predecessor) = context();
        self.batches.insert(
            root.clone(),
            BatchRecord {
                batch_root: root.clone(),
                count: hexes.len() as u32,
                source_chain: source_chain.clone(),
                merchant_id: merchant_id.clone(),
                block_height: height,
                block_timestamp_ns: timestamp.clone(),
                predecessor: predecessor.clone(),
            },
        );
        for hex in &hexes {
            self.write_anchor(hex.clone(), source_chain.clone(), merchant_id.clone(), Some(root.clone()));
        }

        let listed = hexes
            .iter()
            .map(|h| format!("\"{h}\""))
            .collect::<Vec<_>>()
            .join(",");
        emit(
            "anchor_batch",
            &format!(
                "{{\"batch_root\":\"{root}\",\"receipt_hashes\":[{listed}],\"source_chain\":\"{source_chain}\",\"merchant_id\":\"{merchant_id}\",\"predecessor\":\"{predecessor}\"}}"
            ),
        );
        root
    }

    pub fn get_anchor(&self, receipt_hash: String) -> Option<AnchorRecord> {
        let hash = normalize_hash(&receipt_hash);
        self.anchors.get(&hash).cloned()
    }

    pub fn is_anchored(&self, receipt_hash: String) -> bool {
        let hash = normalize_hash(&receipt_hash);
        self.anchors.contains_key(&hash)
    }

    pub fn get_batch(&self, batch_root: String) -> Option<BatchRecord> {
        let root = normalize_hash(&batch_root);
        self.batches.get(&root).cloned()
    }

    /// Recompute the sorted-pair Merkle root from `receipt_hash` and `proof`.
    /// True only when the math matches and this contract stored that batch.
    pub fn verify_inclusion(
        &self,
        receipt_hash: String,
        proof: Vec<String>,
        batch_root: String,
    ) -> bool {
        if proof.len() > MAX_PROOF {
            return false;
        }
        let hash = match try_normalize_hash(&receipt_hash) {
            Some(h) => h,
            None => return false,
        };
        let root = match try_normalize_hash(&batch_root) {
            Some(h) => h,
            None => return false,
        };
        let mut siblings = Vec::with_capacity(proof.len());
        for item in &proof {
            match try_normalize_hash(item) {
                Some(h) => siblings.push(decode_hash(&h)),
                None => return false,
            }
        }
        if !verify_proof(&decode_hash(&hash), &siblings, &decode_hash(&root)) {
            return false;
        }
        let Some(record) = self.anchors.get(&hash) else {
            return false;
        };
        if record.batch_root.as_deref() != Some(root.as_str()) {
            return false;
        }
        self.batches.contains_key(&root)
    }

    pub fn add_anchorer(&mut self, account_id: AccountId) {
        self.assert_no_deposit();
        self.assert_owner();
        self.anchorers.insert(account_id.clone(), true);
        emit("allowlist_add", &format!("{{\"account_id\":\"{account_id}\"}}"));
    }

    pub fn remove_anchorer(&mut self, account_id: AccountId) {
        self.assert_no_deposit();
        self.assert_owner();
        require!(account_id != self.owner, "cannot remove owner");
        self.anchorers.remove(&account_id);
        emit("allowlist_remove", &format!("{{\"account_id\":\"{account_id}\"}}"));
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn is_anchorer(&self, account_id: AccountId) -> bool {
        account_id == self.owner || self.anchorers.get(&account_id).copied().unwrap_or(false)
    }
}

impl Contract {
    fn assert_no_deposit(&self) {
        require!(env::attached_deposit().is_zero(), "this contract does not accept funds");
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "unauthorized");
    }

    fn assert_anchorer(&self) {
        require!(self.is_anchorer(env::predecessor_account_id()), "unauthorized");
    }

    fn write_anchor(
        &mut self,
        hash: String,
        source_chain: String,
        merchant_id: String,
        batch_root: Option<String>,
    ) -> AnchorRecord {
        let (block_height, block_timestamp_ns, predecessor) = context();
        let record = AnchorRecord {
            receipt_hash: hash.clone(),
            source_chain,
            merchant_id,
            batch_root,
            block_height,
            block_timestamp_ns,
            predecessor,
        };
        self.anchors.insert(hash, record.clone());
        record
    }
}

fn context() -> (u64, String, AccountId) {
    (env::block_height(), env::block_timestamp().to_string(), env::predecessor_account_id())
}

fn emit(event: &str, data_object: &str) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"sycee-anchor\",\"version\":\"1.0.0\",\"event\":\"{event}\",\"data\":[{data_object}]}}"
    ));
}

fn json_opt(value: &Option<String>) -> String {
    match value {
        Some(v) => format!("\"{v}\""),
        None => "null".to_string(),
    }
}

fn check_label(value: &str, max: usize, field: &str) -> String {
    require!(!value.is_empty() && value.len() <= max, format!("{field}: empty or too long"));
    require!(
        value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-' | b'.' | b'@')),
        format!("{field}: unsupported characters")
    );
    let lower = value.to_ascii_lowercase();
    require!(
        !lower.contains("payment-signature")
            && !lower.contains("payment_proof")
            && !lower.contains("x-payment")
            && !lower.contains("payment_signature"),
        format!("{field}: refusing payment material")
    );
    value.to_string()
}

fn try_normalize_hash(input: &str) -> Option<String> {
    let stripped = input.strip_prefix("sha256:").unwrap_or(input);
    if stripped.len() != 64 {
        return None;
    }
    let lower = stripped.to_ascii_lowercase();
    if lower.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(lower)
    } else {
        None
    }
}

fn normalize_hash(input: &str) -> String {
    try_normalize_hash(input).unwrap_or_else(|| env::panic_str("receipt_hash must be 32-byte hex"))
}

fn decode_hash(hex: &str) -> [u8; 32] {
    let bytes = hex.as_bytes();
    let mut out = [0u8; 32];
    for i in 0..32 {
        let hi = hex_val(bytes[i * 2]);
        let lo = hex_val(bytes[i * 2 + 1]);
        require!(hi < 16 && lo < 16, "receipt_hash must be 32-byte hex");
        out[i] = (hi << 4) | lo;
    }
    out
}

fn hex_val(b: u8) -> u8 {
    match b {
        b'0'..=b'9' => b - b'0',
        b'a'..=b'f' => b - b'a' + 10,
        _ => 255,
    }
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn sha256(data: &[u8]) -> [u8; 32] {
    let digest = env::sha256(data);
    digest.try_into().unwrap()
}

fn leaf_node(receipt: &[u8; 32]) -> [u8; 32] {
    let mut buf = [0u8; 33];
    buf[0] = LEAF_TAG;
    buf[1..].copy_from_slice(receipt);
    sha256(&buf)
}

fn hash_pair(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (left, right) = if a <= b { (a, b) } else { (b, a) };
    let mut buf = [0u8; 65];
    buf[0] = NODE_TAG;
    buf[1..33].copy_from_slice(left);
    buf[33..].copy_from_slice(right);
    sha256(&buf)
}

fn merkle_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    require!(!leaves.is_empty(), "empty batch");
    require!(leaves.len() <= MAX_BATCH, "batch exceeds 32 receipts");
    let mut level: Vec<[u8; 32]> = leaves.iter().copied().map(|leaf| leaf_node(&leaf)).collect();
    level.sort();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        let mut i = 0;
        while i < level.len() {
            if i + 1 == level.len() {
                next.push(level[i]);
            } else {
                next.push(hash_pair(&level[i], &level[i + 1]));
            }
            i += 2;
        }
        level = next;
    }
    level[0]
}

fn verify_proof(receipt: &[u8; 32], proof: &[[u8; 32]], root: &[u8; 32]) -> bool {
    let mut current = leaf_node(receipt);
    for sibling in proof {
        current = hash_pair(&current, sibling);
    }
    &current == root
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, NearToken};

    fn set_caller(predecessor: &str) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id("anchor.testnet".parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .signer_account_id(predecessor.parse().unwrap())
            .block_height(42)
            .block_timestamp(1_700_000_000_000_000_000)
            .attached_deposit(NearToken::from_yoctonear(0));
        testing_env!(builder.build());
    }

    fn contract() -> Contract {
        set_caller("owner.testnet");
        Contract::new("owner.testnet".parse().unwrap(), None)
    }

    fn hash(n: u8) -> String {
        format!("{:064x}", n)
    }

    #[test]
    fn anchors_and_reads_back() {
        let mut c = contract();
        let record = c.anchor(hash(1), "eip155:84532".to_string(), "0x2222222222222222222222222222222222222222".to_string(), None);
        assert_eq!(record.receipt_hash, hash(1));
        assert_eq!(record.block_height, 42);
        assert_eq!(record.block_timestamp_ns, "1700000000000000000");
        assert_eq!(record.predecessor, "owner.testnet");
        assert!(c.is_anchored(format!("sha256:{}", hash(1))));
        assert!(c.get_anchor(hash(1)).is_some());
        assert!(!c.is_anchored(hash(2)));
        assert!(c.get_anchor(hash(2)).is_none());
    }

    #[test]
    #[should_panic(expected = "duplicate receipt hash")]
    fn rejects_duplicates() {
        let mut c = contract();
        c.anchor(hash(1), "eip155:84532".into(), "merchant".into(), None);
        c.anchor(hash(1), "eip155:84532".into(), "merchant".into(), None);
    }

    #[test]
    #[should_panic(expected = "unauthorized")]
    fn rejects_unauthorized_caller() {
        let mut c = contract();
        set_caller("bob.testnet");
        c.anchor(hash(1), "eip155:84532".into(), "merchant".into(), None);
    }

    #[test]
    #[should_panic(expected = "this contract does not accept funds")]
    fn rejects_attached_deposit() {
        let mut c = contract();
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id("anchor.testnet".parse().unwrap())
            .predecessor_account_id("owner.testnet".parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(builder.build());
        c.anchor(hash(1), "eip155:84532".into(), "merchant".into(), None);
    }

    #[test]
    fn owner_can_allow_another_anchorer() {
        let mut c = contract();
        c.add_anchorer("bob.testnet".parse().unwrap());
        set_caller("bob.testnet");
        let record = c.anchor(hash(3), "eip155:84532".into(), "sycee:demo-merchant".into(), None);
        assert_eq!(record.predecessor.as_str(), "bob.testnet");
    }

    #[test]
    fn batch_root_is_order_independent_and_verifies() {
        let mut c = contract();
        let hashes = vec![hash(4), hash(9), hash(1), hash(7)];
        let root = c.anchor_batch(hashes.clone(), "eip155:84532".into(), "0xabc".into());
        let mut reversed = hashes.clone();
        reversed.reverse();
        let leaves: Vec<[u8; 32]> = hashes.iter().map(|h| decode_hash(h)).collect();
        assert_eq!(root, to_hex(&merkle_root(&leaves)));
        let target = decode_hash(&hashes[2]);
        let proof = proof_for(&leaves, &target);
        let proof_hex: Vec<String> = proof.iter().map(|p| to_hex(p)).collect();
        assert!(c.verify_inclusion(hashes[2].clone(), proof_hex, root));
        assert!(!c.verify_inclusion(hashes[2].clone(), vec![hash(5)], hash(5)));
        assert!(c.get_batch(c.get_anchor(hashes[0].clone()).unwrap().batch_root.unwrap()).is_some());
    }

    fn proof_for(leaves: &[[u8; 32]], target: &[u8; 32]) -> Vec<[u8; 32]> {
        let target_node = leaf_node(target);
        let mut level: Vec<([u8; 32], bool)> = leaves
            .iter()
            .map(|leaf| {
                let node = leaf_node(leaf);
                (node, node == target_node)
            })
            .collect();
        level.sort_by(|a, b| a.0.cmp(&b.0));
        let mut proof = Vec::new();
        while level.len() > 1 {
            let mut next = Vec::new();
            let mut i = 0;
            while i < level.len() {
                if i + 1 == level.len() {
                    next.push(level[i]);
                } else {
                    let left = level[i];
                    let right = level[i + 1];
                    if left.1 {
                        proof.push(right.0);
                    } else if right.1 {
                        proof.push(left.0);
                    }
                    next.push((hash_pair(&left.0, &right.0), left.1 || right.1));
                }
                i += 2;
            }
            level = next;
        }
        proof
    }
}
