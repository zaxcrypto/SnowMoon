//! Snapfall Core contract: JobVault + FloatPool + AsyncOps + StorageCredits + Governance.
pub mod async_ops;
pub mod events;
pub mod governance;
pub mod math;
pub mod pool;
pub mod storage_credits;
#[cfg(test)]
mod tests;
pub mod types;
pub mod vault;

use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, ext_contract, near, require, serde_json, AccountId, BorshStorageKey, Gas, PanicOnDefault,
    PromiseOrValue,
};
use storage_credits::JOB_STORAGE_DEPOSIT_INITIAL;
use types::{
    AccountingView, Advance, ClaimEntry, Hex32, Job, OrgCredit, PendingNearOp, PendingOp, ShareEntry,
    StorageCreditEntry, TransferMsg,
};

pub const TIMELOCK_DELAY_SEC: u64 = 172_800; // 2 days
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
pub const GAS_PAYOUT_CALLBACK: Gas = Gas::from_tgas(45);
pub const GAS_NEAR_TRANSFER_CALLBACK: Gas = Gas::from_tgas(10);
pub const MIN_PREPAID_GAS_PAYOUT: Gas = Gas::from_tgas(110);

#[inline]
pub(crate) fn block_timestamp_sec() -> u64 {
    env::block_timestamp_ms() / 1_000
}

/// Decision 2: domain separator for contract-derived job ids (SnowMoon namespace, fixed before deployment).
/// Changing it after deployment would change every future id, so it is versioned (`/v1`).
pub const JOB_ID_DOMAIN: &[u8] = b"snowmoon-core/job-id/v1";

/// job_id = sha256( JOB_ID_DOMAIN || borsh(creator) || seq.to_le_bytes() ).
/// `creator` is the account that created the job (`create_job` caller, or `sender_id` of CreateAndFundJob).
/// `seq` comes from the global strictly increasing `next_job_seq`, so no two issued ids share a preimage.
pub fn derive_job_id(creator: &AccountId, seq: u64) -> Hex32 {
    let mut buf = Vec::with_capacity(JOB_ID_DOMAIN.len() + 68 + 8);
    buf.extend_from_slice(JOB_ID_DOMAIN);
    buf.extend_from_slice(&near_sdk::borsh::to_vec(creator).expect("ERR_BORSH"));
    buf.extend_from_slice(&seq.to_le_bytes());
    let digest = env::sha256(&buf);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    Hex32(out)
}

impl Contract {
    /// Issue the next job id for `creator`. The sequence only ever moves forward.
    pub(crate) fn issue_job_id(&mut self, creator: &AccountId) -> (Hex32, u64) {
        let seq = self.next_job_seq;
        self.next_job_seq = seq.checked_add(1).expect("ERR_JOB_SEQ_OVERFLOW");
        let job_id = derive_job_id(creator, seq);
        // Defensive: a collision would require a SHA-256 collision.
        require!(!self.jobs.contains_key(&job_id), "ERR_JOB_EXISTS");
        (job_id, seq)
    }
}

#[ext_contract(ext_ft)]
pub trait ExtFungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[derive(BorshStorageKey, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
pub enum StorageKey {
    StorageCredits,
    StorageWithdrawLock,
    PendingNearOps,
    Jobs,
    Advances,
    OrgCredit,
    SharesOf,
    PendingOps,
    ClaimableUsdc,
    AllowedDepositors,
    AllowedRelayers,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub usdc_token: AccountId,

    // StorageCredits + PendingNearOp (POD-03A, FC-02, FC-04)
    pub storage_credits: LookupMap<AccountId, StorageCreditEntry>,
    pub storage_withdraw_lock: LookupMap<AccountId, u64>,
    pub pending_near_ops: LookupMap<u64, PendingNearOp>,
    pub next_near_op_id: u64,
    pub job_storage_deposit: u128,
    pub pending_job_storage_deposit: Option<u128>,
    pub storage_deposit_lower_executable_at: u64,
    pub total_storage_credits: u128,
    pub total_storage_locked: u128,
    pub total_inflight_storage_near: u128,
    /// Registration refunds in flight (tracked separately from balance withdrawals).
    pub total_inflight_registration: u128,
    /// Decision 4: caller-funded registration NEAR held by storage-credit records.
    pub total_storage_registration: u128,

    // JobVault
    pub jobs: LookupMap<Hex32, Job>,
    /// Decision 2: global, strictly increasing job sequence. Never decremented or reset.
    pub next_job_seq: u64,
    pub escrowed_usdc: u128,
    pub max_job_payment: u128,
    pub vault_paused: bool,

    // FloatPool
    pub advances: LookupMap<Hex32, Advance>,
    pub org_credit: LookupMap<AccountId, OrgCredit>,
    pub shares_of: LookupMap<(u64, AccountId), ShareEntry>,
    pub share_epoch: u64,
    pub total_assets: u128,
    pub total_outstanding: u128,
    pub total_written_off: u128,
    pub reserve: u128,
    pub total_shares: u128,
    pub max_total_exposure: u128,
    pub max_advance: u128,
    pub pool_paused: bool,

    // AsyncOps & Claims
    pub pending_ops: LookupMap<u64, PendingOp>,
    pub claimable_usdc: LookupMap<AccountId, ClaimEntry>,
    pub next_op_id: u64,
    pub total_in_flight_usdc: u128,
    pub total_claimable_usdc: u128,
    pub flagged_stuck_count: u32,

    // Governance
    pub admin: AccountId,
    pub pending_admin: Option<AccountId>,
    pub admin_transfer_acceptable_at: u64,
    pub deposit_allowlist_enabled: bool,
    pub allowed_depositors: LookupSet<AccountId>,
    pub allowed_relayers: LookupSet<AccountId>,
    pub pending_max_total_exposure: u128,
    pub pending_max_advance: u128,
    pub cap_raise_executable_at: u64,

    // Gated test-only hook for T-28 (excluded from normal production builds)
    #[cfg(feature = "test-fail-callback")]
    pub test_force_payout_callback_panic: bool,
}

#[near]
impl Contract {
    #[init]
    pub fn new(usdc_token: AccountId, admin: AccountId) -> Self {
        let mut allowed_depositors = LookupSet::new(StorageKey::AllowedDepositors);
        allowed_depositors.insert(admin.clone());

        Self {
            usdc_token,
            storage_credits: LookupMap::new(StorageKey::StorageCredits),
            storage_withdraw_lock: LookupMap::new(StorageKey::StorageWithdrawLock),
            pending_near_ops: LookupMap::new(StorageKey::PendingNearOps),
            next_near_op_id: 1,
            job_storage_deposit: JOB_STORAGE_DEPOSIT_INITIAL,
            pending_job_storage_deposit: None,
            storage_deposit_lower_executable_at: 0,
            total_storage_credits: 0,
            total_storage_locked: 0,
            total_inflight_storage_near: 0,
            total_inflight_registration: 0,
            total_storage_registration: 0,
            jobs: LookupMap::new(StorageKey::Jobs),
            next_job_seq: 1,
            escrowed_usdc: 0,
            max_job_payment: 0,
            vault_paused: false,
            advances: LookupMap::new(StorageKey::Advances),
            org_credit: LookupMap::new(StorageKey::OrgCredit),
            shares_of: LookupMap::new(StorageKey::SharesOf),
            share_epoch: 1,
            total_assets: 0,
            total_outstanding: 0,
            total_written_off: 0,
            reserve: 0,
            total_shares: 0,
            max_total_exposure: 0,
            max_advance: 0,
            pool_paused: false,
            pending_ops: LookupMap::new(StorageKey::PendingOps),
            claimable_usdc: LookupMap::new(StorageKey::ClaimableUsdc),
            next_op_id: 1,
            total_in_flight_usdc: 0,
            total_claimable_usdc: 0,
            flagged_stuck_count: 0,
            admin,
            pending_admin: None,
            admin_transfer_acceptable_at: 0,
            deposit_allowlist_enabled: true,
            allowed_depositors,
            allowed_relayers: LookupSet::new(StorageKey::AllowedRelayers),
            pending_max_total_exposure: 0,
            pending_max_advance: 0,
            cap_raise_executable_at: 0,
            #[cfg(feature = "test-fail-callback")]
            test_force_payout_callback_panic: false,
        }
    }

    /// NEP-141 receiver entrypoint. Only accepts transfers from `self.usdc_token`.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.usdc_token,
            "ERR_UNTRUSTED_TOKEN"
        );
        let parsed: TransferMsg =
            serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("ERR_INVALID_TRANSFER_MSG"));
        match parsed {
            TransferMsg::CreateAndFundJob {
                job_id,
                operator,
                max_operating_budget,
                terms_hash,
                deadline,
            } => self.handle_create_and_fund(
                sender_id,
                amount.0,
                job_id,
                operator,
                max_operating_budget.0,
                terms_hash,
                deadline,
            ),
            TransferMsg::FundJob { job_id } => self.handle_fund_job(sender_id, amount.0, job_id),
            TransferMsg::DepositPool { receiver } => {
                self.handle_deposit_pool(sender_id, amount.0, receiver)
            }
        }
    }

    pub fn accounting(&self) -> AccountingView {
        AccountingView {
            escrowed_usdc: U128(self.escrowed_usdc),
            total_assets: U128(self.total_assets),
            total_outstanding: U128(self.total_outstanding),
            total_written_off: U128(self.total_written_off),
            reserve: U128(self.reserve),
            total_shares: U128(self.total_shares),
            share_epoch: self.share_epoch,
            total_claimable_usdc: U128(self.total_claimable_usdc),
            total_in_flight_usdc: U128(self.total_in_flight_usdc),
            flagged_stuck_count: self.flagged_stuck_count,
            total_storage_credits: U128(self.total_storage_credits),
            total_storage_locked: U128(self.total_storage_locked),
            total_inflight_storage_near: U128(self.total_inflight_storage_near),
            total_inflight_registration: U128(self.total_inflight_registration),
            total_storage_registration: U128(self.total_storage_registration),
            next_job_seq: self.next_job_seq,
            vault_paused: self.vault_paused,
            pool_paused: self.pool_paused,
        }
    }

    #[cfg(feature = "test-fail-callback")]
    pub fn set_test_force_payout_callback_panic(&mut self, enabled: bool) {
        self.test_force_payout_callback_panic = enabled;
    }
}
