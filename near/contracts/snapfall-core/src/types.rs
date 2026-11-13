//! Core data types (spec §4.1, §7.1, §9.2).
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Deserializer, Serialize, Serializer};
use near_sdk::AccountId;

/// 32-byte identifier / hash. JSON form: "0x" + 64 lowercase hex chars.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Hex32(pub [u8; 32]);

impl Hex32 {
    pub const ZERO: Hex32 = Hex32([0u8; 32]);
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
        let bytes = h.as_bytes();
        for i in 0..32 {
            let hi = nib(bytes[2 * i])?;
            let lo = nib(bytes[2 * i + 1])?;
            out[i] = (hi << 4) | lo;
        }
        Ok(Hex32(out))
    }
}

fn nib(c: u8) -> Result<u8, &'static str> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        _ => Err("ERR_HEX32_CHAR"), // lowercase only (canonical form)
    }
}

impl Serialize for Hex32 {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for Hex32 {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = <String as Deserialize>::deserialize(d)?;
        Hex32::from_hex(&s).map_err(near_sdk::serde::de::Error::custom)
    }
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub enum JobStatus {
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

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Job {
    pub customer: AccountId,
    pub operator: AccountId,
    pub customer_payment: u128,
    pub max_operating_budget: u128,
    pub onchain_expenses: u128,
    pub terms_hash: Hex32,
    pub delivery_hash: Hex32,
    pub deadline: u64,
    pub status: JobStatus,
    pub storage_sponsor: AccountId,
    pub storage_locked: u128,
    pub active_op_id: Option<u64>,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub enum AdvanceStatus {
    None,
    PayoutPending,
    Issued,
    Repaid,
    WrittenOff,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Advance {
    pub job_id: Hex32,
    pub operator_org: AccountId,
    pub principal: u128,
    pub fee: u128,
    pub rate_bps: u16,
    pub opened_at: u64,
    pub status: AdvanceStatus,
    pub active_op_id: Option<u64>,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default)]
#[borsh(crate = "near_sdk::borsh")]
pub struct OrgCredit {
    pub accepted_jobs: u32,
    pub written_off_jobs: u32,
    pub outstanding: u128,
}

/// What a USDC PendingOp pays out, and where a failed transfer is credited.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub enum PendingOpKind {
    /// request_advance principal → job.operator. Failure credits operator.
    AdvancePayout { job_id: Hex32 },
    /// accept_delivery operator_net → job.operator. Failure credits operator.
    SettlementOperatorPayout { job_id: Hex32, advance_repaid: u128 },
    /// refund customer_payment → job.customer. Failure credits customer.
    RefundCustomer { job_id: Hex32 },
    /// withdraw/redeem assets → receiver. Failure credits receiver.
    /// `epoch` locates the LP's share entry, which owns the storage slots that fund any new claim entry.
    LpWithdraw { lp: AccountId, epoch: u64 },
    /// claim_usdc → recipient. Failure restores the claim to `owner` (additively).
    Claim { owner: AccountId },
}

/// LP share position in one epoch (Decision 3). All of the LP's exit storage is reserved here at deposit time:
/// the entry itself, one in-flight exit op, and two claim slots (one for the LP's own failed payouts, one for
/// a failed payout to an external receiver). No NEAR is ever required at withdrawal time.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default)]
#[borsh(crate = "near_sdk::borsh")]
pub struct ShareEntry {
    pub shares: u128,
    /// Caller-funded NEAR still held by this entry (slot stakes in use live on their claim entries).
    pub storage_stake: u128,
    /// One in-flight exit per LP; the entry is kept until that op resolves.
    pub active_exit_op: Option<u64>,
    pub self_slot_used: bool,
    pub external_slot_used: bool,
}

/// Pull-claim balance (Decision 4). `active_op` is the single in-flight claim op for this owner.
/// `storage_stake` / `storage_payer` record who funded this entry's bytes (LP share entry `(epoch, lp)`), so the
/// stake returns to exactly that payer when the entry is removed. Job-originated entries have stake 0 / payer None
/// (their bytes are covered by the job storage deposit).
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default)]
#[borsh(crate = "near_sdk::borsh")]
pub struct ClaimEntry {
    pub balance: u128,
    pub active_op: Option<u64>,
    pub storage_stake: u128,
    pub storage_payer: Option<(u64, AccountId)>,
}

/// Storage-credit record (Decision 4 / AUD-08). `registration` is caller-funded NEAR that pays for this record
/// and one in-flight storage withdrawal (PendingNearOp + lock). It is refunded when the account fully exits.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default)]
#[borsh(crate = "near_sdk::borsh")]
pub struct StorageCreditEntry {
    pub balance: u128,
    pub registration: u128,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct PendingOp {
    pub op_id: u64,
    pub kind: PendingOpKind,
    pub recipient: AccountId,
    pub amount: u128,
    pub created_at_block: u64,
    pub created_at_sec: u64,
    pub flagged_stuck: bool,
}

/// Native-NEAR storage withdrawal in flight (FC-02). Fully separate from PendingOp.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct PendingNearOp {
    pub near_op_id: u64,
    pub account: AccountId,
    pub amount: u128,
    pub created_at_block: u64,
    pub flagged_stuck: bool,
    /// true = this op refunds the account's registration (final step of a full storage exit).
    pub registration_refund: bool,
}

/// ft_on_transfer `msg` (externally tagged JSON), e.g. {"FundJob":{"job_id":"0x.."}}.
#[derive(Deserialize, Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub enum TransferMsg {
    /// Decision 2: the job id is generated by the contract. A caller-supplied `job_id` is rejected explicitly
    /// (ERR_JOB_ID_IS_CONTRACT_GENERATED) so an outdated client cannot silently believe its id was used.
    CreateAndFundJob {
        #[serde(default)]
        job_id: Option<Hex32>,
        operator: AccountId,
        max_operating_budget: near_sdk::json_types::U128,
        terms_hash: Hex32,
        deadline: u64,
    },
    FundJob {
        job_id: Hex32,
    },
    DepositPool {
        receiver: Option<AccountId>,
    },
}

// ───────────── JSON view types ─────────────
use near_sdk::json_types::U128;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct JobView {
    pub job_id: Hex32,
    pub customer: AccountId,
    pub operator: AccountId,
    pub customer_payment: U128,
    pub max_operating_budget: U128,
    pub onchain_expenses: U128,
    pub terms_hash: Hex32,
    pub delivery_hash: Hex32,
    pub deadline: u64,
    pub status: JobStatus,
    pub storage_sponsor: AccountId,
    pub storage_locked: U128,
    pub active_op_id: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct AdvanceView {
    pub job_id: Hex32,
    pub operator_org: AccountId,
    pub principal: U128,
    pub fee: U128,
    pub rate_bps: u16,
    pub opened_at: u64,
    pub status: AdvanceStatus,
    pub active_op_id: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct PendingOpView {
    pub op_id: u64,
    pub kind: PendingOpKind,
    pub recipient: AccountId,
    pub amount: U128,
    pub created_at_block: u64,
    pub flagged_stuck: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct AccountingView {
    pub escrowed_usdc: U128,
    pub total_assets: U128,
    pub total_outstanding: U128,
    pub total_written_off: U128,
    pub reserve: U128,
    pub total_shares: U128,
    pub share_epoch: u64,
    pub total_claimable_usdc: U128,
    pub total_in_flight_usdc: U128,
    pub flagged_stuck_count: u32,
    pub total_storage_credits: U128,
    pub total_storage_locked: U128,
    pub total_storage_registration: U128,
    pub next_job_seq: u64,
    pub total_inflight_storage_near: U128,
    pub total_inflight_registration: U128,
    pub vault_paused: bool,
    pub pool_paused: bool,
}

/// Minimal cross-contract verification payload for AuditAnchor (spec §5.1).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct AuditJobVerification {
    pub exists: bool,
    pub status: Option<JobStatus>,
    pub delivery_hash: Option<Hex32>,
}

