//! AuditAnchor contract (`audit.snapfall.<network>`, MC-02).
//! Verifies job `Accepted` status and `delivery_hash` asynchronously against `snapfall-core`.
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Deserializer, Serialize, Serializer};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas,
    NearToken, PanicOnDefault, Promise, PromiseError,
};

pub const TIMELOCK_DELAY_SEC: u64 = 172_800;
pub const GAS_VERIFY_CORE: Gas = Gas::from_tgas(15);
pub const GAS_AUDIT_CALLBACK: Gas = Gas::from_tgas(25);
pub const MIN_PREPAID_GAS_AUDIT: Gas = Gas::from_tgas(60);
/// Decision 5: storage deposit attached by the caller of `anchor_job`. Covers the transient
/// PendingAnchor + in-flight marker with >= 1.5x margin (measured in unit tests).
pub const ANCHOR_STORAGE_DEPOSIT: u128 = 6_000_000_000_000_000_000_000; // 0.006 NEAR
/// Decision 5: portion retained (locked) when an Anchor is finalized; covers the permanent Anchor
/// record with >= 1.5x margin. The remainder is refunded to the payer.
pub const ANCHOR_FINAL_STAKE: u128 = 3_000_000_000_000_000_000_000; // 0.003 NEAR

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Hex32(pub [u8; 32]);

impl Hex32 {
    pub fn is_zero(&self) -> bool {
        self.0 == [0u8; 32]
    }
    pub fn to_hex(&self) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut s = String::with_capacity(66);
        s.push_str("0x");
        for b in self.0.iter() {
            s.push(HEX[(b >> 4) as usize] as char);
            s.push(HEX[(b & 0x0f) as usize] as char);
        }
        s
    }
    pub fn from_hex(s: &str) -> Result<Self, &'static str> {
        let h = s.strip_prefix("0x").ok_or("ERR_HEX32_PREFIX")?;
        if h.len() != 64 {
            return Err("ERR_HEX32_LEN");
        }
        let mut out = [0u8; 32];
        let b = h.as_bytes();
        for i in 0..32 {
            let hi = nib(b[2 * i])?;
            let lo = nib(b[2 * i + 1])?;
            out[i] = (hi << 4) | lo;
        }
        Ok(Hex32(out))
    }
}

fn nib(c: u8) -> Result<u8, &'static str> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        _ => Err("ERR_HEX32_CHAR"),
    }
}

impl Serialize for Hex32 {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_hex())
    }
}
impl<'de> Deserialize<'de> for Hex32 {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Hex32::from_hex(&<String as Deserialize>::deserialize(d)?).map_err(near_sdk::serde::de::Error::custom)
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub enum CoreJobStatus {
    Created,
    Funded,
    InProgress,
    Delivered,
    Accepted,
    Refunded,
    Cancelled,
    Settling,
    Refunding,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct AuditJobVerification {
    pub exists: bool,
    pub status: Option<CoreJobStatus>,
    pub delivery_hash: Option<Hex32>,
}

#[ext_contract(ext_core)]
pub trait ExtSnapfallCore {
    fn verify_job_for_audit(&self, job_id: Hex32) -> AuditJobVerification;
}

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct Anchor {
    pub event_root: Hex32,
    pub payment_receipt_root: Hex32,
    pub delivery_hash: Hex32,
    pub completed_at: u64,
    pub anchored_at_sec: u64,
    pub finalized: bool,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct PendingAnchor {
    pub audit_op_id: u64,
    pub job_id: Hex32,
    pub event_root: Hex32,
    pub payment_receipt_root: Hex32,
    pub delivery_hash: Hex32,
    pub completed_at: u64,
    /// Decision 5: who paid the storage deposit and how much (refund target).
    pub payer: AccountId,
    pub storage_deposit: u128,
}

#[derive(BorshStorageKey, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
pub enum AuditStorageKey {
    Anchors,
    PendingVerifications,
    JobsPendingAnchor,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct AuditAnchor {
    pub core_contract: AccountId,
    pub operator_authority: AccountId,
    pub admin: AccountId,
    pub pending_admin: Option<AccountId>,
    pub admin_transfer_acceptable_at: u64,
    pub anchors: LookupMap<Hex32, Anchor>,
    pub pending_verifications: LookupMap<u64, PendingAnchor>,
    pub jobs_pending_anchor: LookupSet<Hex32>,
    pub next_audit_op_id: u64,
    /// Decision 5: NEAR retained to fund finalized Anchor records (caller-funded, never owner-sponsored).
    pub total_anchor_storage_locked: u128,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let v = json!({"standard": "snapfall", "version": "1.0.0", "event": event, "data": [data]});
    env::log_str(&format!("EVENT_JSON:{}", v));
}

#[near]
impl AuditAnchor {
    #[init]
    pub fn new(core_contract: AccountId, operator_authority: AccountId, admin: AccountId) -> Self {
        Self {
            core_contract,
            operator_authority,
            admin,
            pending_admin: None,
            admin_transfer_acceptable_at: 0,
            anchors: LookupMap::new(AuditStorageKey::Anchors),
            pending_verifications: LookupMap::new(AuditStorageKey::PendingVerifications),
            jobs_pending_anchor: LookupSet::new(AuditStorageKey::JobsPendingAnchor),
            next_audit_op_id: 1,
            total_anchor_storage_locked: 0,
        }
    }

    /// Initiate asynchronous verification against `core::verify_job_for_audit` (MC-02).
    /// Decision 5: caller attaches >= `ANCHOR_STORAGE_DEPOSIT`; validated before any write.
    #[payable]
    pub fn anchor_job(
        &mut self,
        job_id: Hex32,
        event_root: Hex32,
        payment_receipt_root: Hex32,
        delivery_hash: Hex32,
        completed_at: u64,
    ) -> Promise {
        require!(
            env::predecessor_account_id() == self.operator_authority,
            "ERR_NOT_OPERATOR_AUTHORITY"
        );
        require!(env::prepaid_gas() >= MIN_PREPAID_GAS_AUDIT, "ERR_INSUFFICIENT_GAS");
        require!(!event_root.is_zero() && !delivery_hash.is_zero(), "ERR_ZERO_HASH");
        require!(!self.anchors.contains_key(&job_id), "ERR_ALREADY_FINALIZED");
        require!(
            !self.jobs_pending_anchor.contains(&job_id),
            "ERR_ANCHOR_IN_FLIGHT"
        );
        let storage_deposit = env::attached_deposit().as_yoctonear();
        require!(storage_deposit >= ANCHOR_STORAGE_DEPOSIT, "ERR_INSUFFICIENT_STORAGE_DEPOSIT");
        let payer = env::predecessor_account_id();

        let audit_op_id = self.next_audit_op_id;
        self.next_audit_op_id += 1;
        self.jobs_pending_anchor.insert(job_id);
        self.pending_verifications.insert(
            audit_op_id,
            PendingAnchor {
                audit_op_id,
                job_id,
                event_root,
                payment_receipt_root,
                delivery_hash,
                completed_at,
                payer,
                storage_deposit,
            },
        );

        ext_core::ext(self.core_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(0))
            .with_static_gas(GAS_VERIFY_CORE)
            .verify_job_for_audit(job_id)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_AUDIT_CALLBACK)
                    .on_verify_job_complete(audit_op_id),
            )
    }

    #[private]
    pub fn on_verify_job_complete(
        &mut self,
        audit_op_id: u64,
        #[callback_result] res: Result<AuditJobVerification, PromiseError>,
    ) -> bool {
        // AUD-04: an unknown audit_op_id must not panic the callback; log an anomaly and return false.
        let Some(pending) = self.pending_verifications.remove(&audit_op_id) else {
            emit("AuditCallbackAnomaly", json!({"auditOpId": audit_op_id}));
            return false;
        };
        self.jobs_pending_anchor.remove(&pending.job_id);

        let reason: Option<&str> = match res {
            Err(_) => Some("CROSS_CONTRACT_ERROR"),
            Ok(v) if !v.exists => Some("JOB_NOT_FOUND"),
            Ok(v) if v.status != Some(CoreJobStatus::Accepted) => Some("JOB_NOT_ACCEPTED"),
            Ok(v) if v.delivery_hash != Some(pending.delivery_hash) => Some("DELIVERY_HASH_MISMATCH"),
            Ok(_) => None,
        };

        if let Some(r) = reason {
            // Nothing persisted: refund the full storage deposit to the payer.
            Self::refund_storage(&pending.payer, pending.storage_deposit);
            emit(
                "AnchorVerificationFailed",
                json!({"jobId": pending.job_id.to_hex(), "reason": r,
                       "storageRefundedYocto": pending.storage_deposit.to_string()}),
            );
            return false;
        }

        let anchor = Anchor {
            event_root: pending.event_root,
            payment_receipt_root: pending.payment_receipt_root,
            delivery_hash: pending.delivery_hash,
            completed_at: pending.completed_at,
            anchored_at_sec: env::block_timestamp_ms() / 1_000,
            finalized: true,
        };
        self.anchors.insert(pending.job_id, anchor);
        // Retain the permanent-record stake; refund the rest of the deposit to the payer.
        let retained = ANCHOR_FINAL_STAKE.min(pending.storage_deposit);
        self.total_anchor_storage_locked += retained;
        Self::refund_storage(&pending.payer, pending.storage_deposit - retained);
        emit(
            "JobAnchored",
            json!({"jobId": pending.job_id.to_hex(),
                   "eventRoot": pending.event_root.to_hex(),
                   "paymentReceiptRoot": pending.payment_receipt_root.to_hex(),
                   "deliveryHash": pending.delivery_hash.to_hex(),
                   "completedAt": pending.completed_at}),
        );
        true
    }

    #[payable]
    pub fn set_operator_authority(&mut self, new_operator: AccountId) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.admin, "ERR_NOT_ADMIN");
        self.operator_authority = new_operator.clone();
        emit("OperatorAuthoritySet", json!({"operatorAuthority": new_operator}));
    }

    #[payable]
    pub fn transfer_admin(&mut self, new_admin: AccountId) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.admin, "ERR_NOT_ADMIN");
        if new_admin == self.admin {
            self.pending_admin = None;
            self.admin_transfer_acceptable_at = 0;
            emit("AdminTransferCancelled", json!({}));
            return;
        }
        let acceptable_at = env::block_timestamp_ms() / 1_000 + TIMELOCK_DELAY_SEC;
        self.pending_admin = Some(new_admin.clone());
        self.admin_transfer_acceptable_at = acceptable_at;
        emit(
            "AdminTransferStarted",
            json!({"currentAdmin": self.admin, "pendingAdmin": new_admin, "acceptableAt": acceptable_at}),
        );
    }

    #[payable]
    pub fn accept_admin(&mut self) {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        require!(
            self.pending_admin.as_ref() == Some(&caller),
            "ERR_NOT_PENDING_ADMIN"
        );
        require!(
            env::block_timestamp_ms() / 1_000 >= self.admin_transfer_acceptable_at,
            "ERR_ADMIN_TRANSFER_TIMELOCKED"
        );
        let prev = self.admin.clone();
        self.admin = caller.clone();
        self.pending_admin = None;
        self.admin_transfer_acceptable_at = 0;
        emit("AdminTransferred", json!({"previousAdmin": prev, "newAdmin": caller}));
    }

    pub fn get_anchor(&self, job_id: Hex32) -> Option<Anchor> {
        self.anchors.get(&job_id).cloned()
    }
}

impl AuditAnchor {
    fn refund_storage(payer: &AccountId, amount: u128) {
        if amount > 0 {
            Promise::new(payer.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn h(b: u8) -> Hex32 {
        let mut arr = [0u8; 32];
        arr[0] = b;
        Hex32(arr)
    }

    fn ctx(predecessor: &str, deposit: u128, ts_sec: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("audit.snapfall.testnet"))
            .predecessor_account_id(acc(predecessor))
            .signer_account_id(acc(predecessor))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .prepaid_gas(Gas::from_tgas(100))
            .block_timestamp(ts_sec * 1_000_000_000);
        testing_env!(b.build());
    }

    // T-23 (unit level): Verify AuditAnchor async verification callback rules against core
    #[test]
    fn test_audit_anchor_async_verification_against_core_unit() {
        ctx("admin.testnet", 0, 1_000);
        let mut audit = AuditAnchor::new(
            acc("core.snapfall.testnet"),
            acc("authority.testnet"),
            acc("admin.testnet"),
        );

        // Non-authority rejected
        ctx("stranger.testnet", 0, 1_001);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = audit.anchor_job(h(1), h(0xaa), h(0xbb), h(0xcc), 999);
        }))
        .is_err());

        // 1. Job still Delivered (not Accepted) -> rejected in callback, remains unfinalized for retry
        ctx("authority.testnet", ANCHOR_STORAGE_DEPOSIT, 1_002);
        let _ = audit.anchor_job(h(1), h(0xaa), h(0xbb), h(0xcc), 999);
        // Concurrent anchor for same job while in-flight is rejected
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = audit.anchor_job(h(1), h(0xaa), h(0xbb), h(0xcc), 999);
        }))
        .is_err());

        ctx("audit.snapfall.testnet", 0, 1_003);
        let ok = audit.on_verify_job_complete(
            1,
            Ok(AuditJobVerification {
                exists: true,
                status: Some(CoreJobStatus::Delivered),
                delivery_hash: Some(h(0xcc)),
            }),
        );
        assert!(!ok);
        assert!(audit.get_anchor(h(1)).is_none());

        // 2. Job Accepted but delivery_hash mismatch -> rejected in callback, remains unfinalized
        ctx("authority.testnet", ANCHOR_STORAGE_DEPOSIT, 1_004);
        let _ = audit.anchor_job(h(1), h(0xaa), h(0xbb), h(0xdd), 999);
        ctx("audit.snapfall.testnet", 0, 1_005);
        let ok2 = audit.on_verify_job_complete(
            2,
            Ok(AuditJobVerification {
                exists: true,
                status: Some(CoreJobStatus::Accepted),
                delivery_hash: Some(h(0xcc)),
            }),
        );
        assert!(!ok2);
        assert!(audit.get_anchor(h(1)).is_none());

        // 3. Job Accepted and delivery_hash matches -> finalized!
        ctx("authority.testnet", ANCHOR_STORAGE_DEPOSIT, 1_006);
        let _ = audit.anchor_job(h(1), h(0xaa), h(0xbb), h(0xcc), 999);
        ctx("audit.snapfall.testnet", 0, 1_007);
        let ok3 = audit.on_verify_job_complete(
            3,
            Ok(AuditJobVerification {
                exists: true,
                status: Some(CoreJobStatus::Accepted),
                delivery_hash: Some(h(0xcc)),
            }),
        );
        assert!(ok3);
        let anc = audit.get_anchor(h(1)).expect("anchor finalized");
        assert!(anc.finalized);
        assert_eq!(anc.delivery_hash, h(0xcc));
        assert_eq!(anc.anchored_at_sec, 1_007);
        let logs = get_logs();
        assert!(logs.iter().any(|l| l.contains("\"event\":\"JobAnchored\"")));

        // 4. Re-anchoring an already finalized job panics with ERR_ALREADY_FINALIZED
        ctx("authority.testnet", ANCHOR_STORAGE_DEPOSIT, 1_008);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = audit.anchor_job(h(1), h(0xaa), h(0xbb), h(0xcc), 999);
        }))
        .is_err());
    }

    fn events_named(name: &str) -> usize {
        get_logs()
            .iter()
            .filter(|l| l.contains(&format!("\"event\":\"{name}\"")))
            .count()
    }

    // Decision 5: anchor storage is caller-funded. Measure transient and permanent bytes (64-char payer)
    // and check the deposit / retained stake cover them with >= 1.5x margin; under-deposit is rejected.
    #[test]
    fn test_anchor_storage_is_caller_funded_and_measured() {
        let payer = format!("{}.test.near", "a".repeat(54));
        ctx("admin.testnet", 0, 1_000);
        let mut audit = AuditAnchor::new(acc("core.snapfall.testnet"), acc(&payer), acc("admin.testnet"));

        // Under-deposit rejected before any write
        ctx(&payer, ANCHOR_STORAGE_DEPOSIT - 1, 1_001);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = audit.anchor_job(h(7), h(0xaa), h(0xbb), h(0xcc), 999);
        }))
        .is_err());

        ctx(&payer, ANCHOR_STORAGE_DEPOSIT, 1_002);
        audit.pending_verifications.flush();
        audit.anchors.flush();
        let u0 = env::storage_usage();
        let _ = audit.anchor_job(h(7), h(0xaa), h(0xbb), h(0xcc), 999);
        audit.pending_verifications.flush();
        let u1 = env::storage_usage();
        // Direct call (bypasses #[private]) in the same context so storage_usage keeps accumulating.
        let ok = audit.on_verify_job_complete(
            1,
            Ok(AuditJobVerification {
                exists: true,
                status: Some(CoreJobStatus::Accepted),
                delivery_hash: Some(h(0xcc)),
            }),
        );
        assert!(ok);
        audit.pending_verifications.flush();
        audit.anchors.flush();
        let u2 = env::storage_usage();

        let transient = (u1 - u0) as u128;
        let permanent = (u2 - u0) as u128;
        println!("ANCHOR_STORAGE: transient={transient}B permanent={permanent}B");
        let byte_cost = 10_000_000_000_000_000_000u128;
        assert!(ANCHOR_STORAGE_DEPOSIT >= (transient * 3 + 1) / 2 * byte_cost);
        assert!(ANCHOR_FINAL_STAKE >= (permanent * 3 + 1) / 2 * byte_cost);
        assert_eq!(audit.total_anchor_storage_locked, ANCHOR_FINAL_STAKE);
    }

    // AUD-04: unknown audit_op_id in the callback is a non-panicking anomaly that finalizes nothing.
    #[test]
    fn test_unknown_audit_op_callback_is_safe_anomaly() {
        ctx("admin.testnet", 0, 1_000);
        let mut audit = AuditAnchor::new(
            acc("core.snapfall.testnet"),
            acc("authority.testnet"),
            acc("admin.testnet"),
        );
        ctx("audit.snapfall.testnet", 0, 1_001);
        let ok = audit.on_verify_job_complete(
            999,
            Ok(AuditJobVerification {
                exists: true,
                status: Some(CoreJobStatus::Accepted),
                delivery_hash: Some(h(0xcc)),
            }),
        );
        assert!(!ok);
        assert_eq!(events_named("AuditCallbackAnomaly"), 1);
        assert_eq!(events_named("JobAnchored"), 0);
    }

    // AUD-04: 2-step admin transfer emits Started / Cancelled / Transferred and honours the 2-day timelock.
    #[test]
    fn test_audit_admin_transfer_events_and_timelock() {
        ctx("admin.testnet", 0, 1_000);
        let mut audit = AuditAnchor::new(
            acc("core.snapfall.testnet"),
            acc("authority.testnet"),
            acc("admin.testnet"),
        );
        ctx("admin.testnet", 1, 1_000);
        audit.transfer_admin(acc("new-admin.testnet"));
        assert_eq!(events_named("AdminTransferStarted"), 1);

        ctx("admin.testnet", 1, 1_001);
        audit.transfer_admin(acc("admin.testnet"));
        assert_eq!(events_named("AdminTransferCancelled"), 1);
        assert!(audit.pending_admin.is_none());

        ctx("admin.testnet", 1, 2_000);
        audit.transfer_admin(acc("new-admin.testnet"));
        ctx("new-admin.testnet", 1, 2_000 + TIMELOCK_DELAY_SEC - 1);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| audit.accept_admin())).is_err());
        ctx("new-admin.testnet", 1, 2_000 + TIMELOCK_DELAY_SEC);
        audit.accept_admin();
        assert_eq!(audit.admin, acc("new-admin.testnet"));
        assert_eq!(events_named("AdminTransferred"), 1);
    }
}
