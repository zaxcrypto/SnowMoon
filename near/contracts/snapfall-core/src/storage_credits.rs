//! NEP-145-like user storage credits + separate native-NEAR withdrawal queue (POD-03A, FC-02, FC-04).
//! Decision 4 (AUD-08): every storage-credit record is caller-funded by its `registration`, which also pays for
//! one in-flight withdrawal (PendingNearOp + lock). Nothing in this module is Core-sponsored.
use crate::events::{self, JsonObj};
use crate::types::{PendingNearOp, StorageCreditEntry};
use crate::{Contract, ContractExt, GAS_NEAR_TRANSFER_CALLBACK, TIMELOCK_DELAY_SEC};
use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, NearToken, Promise};

/// Owner Decision 1: initial per-job storage deposit = 0.023 NEAR (2,300 B @ 1e19 yocto/B).
/// Worst-case per-job transient peak = 1,521 B (Job 415 + Advance 217 + first OrgCredit 133 + 2 x claim entry
/// in flight 151 + 2 x Claim PendingOp 227); ceil(1.5 x 1,521) = 2,282 B -> 0.02282 NEAR -> rounded up 0.023 NEAR.
/// Verified by T-29 (`test_full_persistent_storage_delta_gate`).
pub const JOB_STORAGE_DEPOSIT_INITIAL: u128 = 23_000_000_000_000_000_000_000;

/// Decision 4: registration for one storage-credit record. Covers the record (141 B) + one in-flight withdrawal
/// (PendingNearOp 150 B + lock 117 B) = 408 B -> ceil(1.5 x 408) = 612 B -> 0.007 NEAR. Measured in unit tests.
pub const STORAGE_REGISTRATION: u128 = 7_000_000_000_000_000_000_000;

/// Decision 3: one LP claim slot = claim entry with payer + active op (227 B) + one Claim PendingOp (227 B)
/// = 454 B -> ceil(1.5 x 454) = 681 B -> 0.007 NEAR.
pub const LP_CLAIM_SLOT_STAKE: u128 = 7_000_000_000_000_000_000_000;
/// Decision 3: share entry with active exit op (160 B) + one LpWithdraw PendingOp (235 B) = 395 B
/// -> ceil(1.5 x 395) = 593 B -> 0.006 NEAR.
pub const LP_SHARE_BASE_STAKE: u128 = 6_000_000_000_000_000_000_000;
/// Decision 3: charged once from storage_credits[sender_id] when a DepositPool creates a share entry.
/// Reserves ALL exit storage up front (base + self claim slot + external claim slot) = 0.020 NEAR, so
/// withdrawal never requires additional NEAR.
pub const LP_SHARE_STAKE: u128 = LP_SHARE_BASE_STAKE + 2 * LP_CLAIM_SLOT_STAKE;

impl Contract {
    fn is_registered(&self, account: &AccountId) -> bool {
        self.storage_credits.contains_key(account)
    }

    /// Credit `amount` to `account`. If the account has no record yet, the first `STORAGE_REGISTRATION` of the
    /// amount funds the new record (disclosed in `StorageRegistered`); the rest becomes withdrawable balance.
    /// Both parts stay refundable to the account.
    pub(crate) fn credit_storage(&mut self, account: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        if let Some(e) = self.storage_credits.get_mut(account) {
            e.balance = e.balance.checked_add(amount).expect("ERR_STORAGE_CREDIT_OVERFLOW");
            self.total_storage_credits = self
                .total_storage_credits
                .checked_add(amount)
                .expect("ERR_TOTAL_STORAGE_OVERFLOW");
            return;
        }
        let registration = amount.min(STORAGE_REGISTRATION);
        let balance = amount - registration;
        self.storage_credits
            .insert(account.clone(), StorageCreditEntry { balance, registration });
        self.total_storage_registration = self
            .total_storage_registration
            .checked_add(registration)
            .expect("ERR_TOTAL_REGISTRATION_OVERFLOW");
        self.total_storage_credits = self
            .total_storage_credits
            .checked_add(balance)
            .expect("ERR_TOTAL_STORAGE_OVERFLOW");
        events::simple(
            "StorageRegistered",
            JsonObj::new()
                .acc("account", account)
                .u128_str("registrationYocto", registration)
                .u128_str("balanceYocto", balance),
        );
    }

    /// Debit withdrawable balance. The record (and its registration) is kept even at balance 0.
    pub(crate) fn debit_storage_exact(&mut self, account: &AccountId, amount: u128, err: &str) {
        let e = self.storage_credits.get_mut(account);
        require!(e.as_ref().map(|e| e.balance >= amount).unwrap_or(false), err);
        let e = e.unwrap();
        e.balance -= amount;
        self.total_storage_credits -= amount;
    }

    /// Final step of a full storage exit: refund the registration through a TRACKED NEAR transfer.
    /// The record is kept (balance 0, registration moved in-flight) until the callback, so a failed transfer
    /// (e.g. the account was deleted) restores the registration to the record. User funds are never lost or
    /// left unattributed; the account (once its name exists again) can retry with `storage_withdraw(None)`.
    fn start_registration_refund(&mut self, account: &AccountId) -> Option<Promise> {
        if self.storage_withdraw_lock.contains_key(account) {
            return None;
        }
        let amt = {
            let e = self.storage_credits.get_mut(account)?;
            if e.balance != 0 || e.registration == 0 {
                return None;
            }
            let amt = e.registration;
            e.registration = 0;
            amt
        };
        self.total_storage_registration -= amt;
        self.total_inflight_registration = self
            .total_inflight_registration
            .checked_add(amt)
            .expect("ERR_INFLIGHT_REGISTRATION_OVERFLOW");
        let near_op_id = self.next_near_op_id;
        self.next_near_op_id += 1;
        self.pending_near_ops.insert(
            near_op_id,
            PendingNearOp {
                near_op_id,
                account: account.clone(),
                amount: amt,
                created_at_block: env::block_height(),
                flagged_stuck: false,
                registration_refund: true,
            },
        );
        self.storage_withdraw_lock.insert(account.clone(), near_op_id);
        events::simple(
            "StorageRegistrationRefundRequested",
            JsonObj::new().u64_num("nearOpId", near_op_id).acc("account", account).u128_str("amountYocto", amt),
        );
        Some(
            Promise::new(account.clone())
                .transfer(NearToken::from_yoctonear(amt))
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_NEAR_TRANSFER_CALLBACK)
                        .on_storage_withdraw_complete(near_op_id),
                ),
        )
    }

    /// Resolve a registration-refund op (called from `on_storage_withdraw_complete`).
    fn resolve_registration_refund(&mut self, near_op_id: u64, op: PendingNearOp, succeeded: bool) {
        self.total_inflight_registration -= op.amount;
        let balance = self.storage_credits.get(&op.account).map(|e| e.balance).unwrap_or(0);
        if succeeded {
            if balance == 0 {
                self.storage_credits.remove(&op.account);
                events::simple(
                    "StorageUnregistered",
                    JsonObj::new()
                        .u64_num("nearOpId", near_op_id)
                        .acc("account", &op.account)
                        .u128_str("registrationRefundedYocto", op.amount),
                );
            } else {
                // A deposit arrived while the refund was in flight: the record must stay funded, so its
                // registration is re-taken from that new balance (disclosed; still refundable later).
                let reg = balance.min(STORAGE_REGISTRATION);
                let e = self.storage_credits.get_mut(&op.account).unwrap();
                e.balance -= reg;
                e.registration = reg;
                self.total_storage_credits -= reg;
                self.total_storage_registration += reg;
                events::simple(
                    "StorageRegistered",
                    JsonObj::new()
                        .acc("account", &op.account)
                        .u128_str("registrationYocto", reg)
                        .u128_str("balanceYocto", balance - reg),
                );
            }
        } else {
            // Failed (e.g. deleted account): restore the registration to the still-existing record.
            if let Some(e) = self.storage_credits.get_mut(&op.account) {
                e.registration += op.amount;
            }
            self.total_storage_registration += op.amount;
            events::simple(
                "StorageRegistrationRefundFailed",
                JsonObj::new()
                    .u64_num("nearOpId", near_op_id)
                    .acc("account", &op.account)
                    .u128_str("amountYocto", op.amount),
            );
        }
    }
    /// Collect `job_storage_deposit` for `create_job` (attached deposit OR pre-deposited credit).
    /// Excess attached deposit is credited to `storage_credits[caller]`. Zero core sponsorship.
    pub(crate) fn lock_storage_for_create_job(&mut self, caller: &AccountId) -> u128 {
        let required = self.job_storage_deposit;
        let attached = env::attached_deposit().as_yoctonear();
        if attached >= required {
            let excess = attached - required;
            // An unregistered caller's excess must be able to fund its own credit record.
            require!(
                excess == 0 || self.is_registered(caller) || excess >= STORAGE_REGISTRATION,
                "ERR_EXCESS_BELOW_REGISTRATION"
            );
            self.credit_storage(caller, excess);
        } else if attached == 0 {
            self.debit_storage_exact(caller, required, "ERR_INSUFFICIENT_STORAGE_DEPOSIT");
        } else {
            env::panic_str("ERR_INSUFFICIENT_STORAGE_DEPOSIT");
        }
        self.total_storage_locked = self
            .total_storage_locked
            .checked_add(required)
            .expect("ERR_TOTAL_LOCKED_OVERFLOW");
        required
    }

    /// Collect `job_storage_deposit` during NEP-141 `CreateAndFundJob` (cannot attach NEAR).
    pub(crate) fn lock_storage_from_credits(&mut self, sender_id: &AccountId) -> u128 {
        let required = self.job_storage_deposit;
        self.debit_storage_exact(sender_id, required, "ERR_INSUFFICIENT_STORAGE_CREDIT");
        self.total_storage_locked = self
            .total_storage_locked
            .checked_add(required)
            .expect("ERR_TOTAL_LOCKED_OVERFLOW");
        required
    }

    pub(crate) fn release_locked_storage(&mut self, sponsor: &AccountId, locked: u128) {
        if locked == 0 {
            return;
        }
        self.total_storage_locked -= locked;
        self.credit_storage(sponsor, locked);
    }
}

#[near]
impl Contract {
    /// Pre-deposit native NEAR for storage (required for 1-step CreateAndFundJob or 0-attached create_job).
    /// Decision 4: the first deposit for an account must cover `STORAGE_REGISTRATION`, which is held (refundably)
    /// to fund the account's credit record; the remainder is withdrawable balance.
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) {
        let amount = env::attached_deposit().as_yoctonear();
        let beneficiary = account_id.unwrap_or_else(env::predecessor_account_id);
        if self.is_registered(&beneficiary) {
            require!(amount > 0, "ERR_ZERO_AMOUNT");
        } else {
            require!(amount >= STORAGE_REGISTRATION, "ERR_BELOW_MIN_STORAGE_DEPOSIT");
        }
        self.credit_storage(&beneficiary, amount);
        events::simple(
            "StorageDeposited",
            JsonObj::new().acc("account", &beneficiary).u128_str("amountYocto", amount),
        );
    }

    /// Withdraw unlocked storage credits asynchronously via a separate `PendingNearOp` (FC-02).
    /// With balance 0 and `amount = None`, the account unregisters and its registration is refunded.
    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<NearToken>) -> Promise {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        require!(
            !self.storage_withdraw_lock.contains_key(&caller),
            "ERR_STORAGE_WITHDRAW_IN_FLIGHT"
        );
        let avail = self
            .storage_credits
            .get(&caller)
            .map(|e| e.balance)
            .unwrap_or_else(|| env::panic_str("ERR_INSUFFICIENT_STORAGE_CREDIT"));
        if avail == 0 && amount.is_none() {
            return self
                .start_registration_refund(&caller)
                .unwrap_or_else(|| env::panic_str("ERR_NOTHING_TO_WITHDRAW"));
        }
        let amt = amount.map(|t| t.as_yoctonear()).unwrap_or(avail);
        require!(amt > 0 && amt <= avail, "ERR_INSUFFICIENT_STORAGE_CREDIT");

        // Synchronous effects before Promise (FC-02 table S0 -> S1). The record and its registration stay,
        // funding the PendingNearOp + lock for the whole flight.
        self.debit_storage_exact(&caller, amt, "ERR_INSUFFICIENT_STORAGE_CREDIT");
        self.total_inflight_storage_near = self
            .total_inflight_storage_near
            .checked_add(amt)
            .expect("ERR_INFLIGHT_NEAR_OVERFLOW");
        let near_op_id = self.next_near_op_id;
        self.next_near_op_id += 1;

        self.pending_near_ops.insert(
            near_op_id,
            PendingNearOp {
                near_op_id,
                account: caller.clone(),
                amount: amt,
                created_at_block: env::block_height(),
                flagged_stuck: false,
                registration_refund: false,
            },
        );
        self.storage_withdraw_lock.insert(caller.clone(), near_op_id);

        events::simple(
            "StorageWithdrawRequested",
            JsonObj::new().u64_num("nearOpId", near_op_id).acc("account", &caller).u128_str("amountYocto", amt),
        );

        Promise::new(caller)
            .transfer(NearToken::from_yoctonear(amt))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_NEAR_TRANSFER_CALLBACK)
                    .on_storage_withdraw_complete(near_op_id),
            )
    }

    #[private]
    pub fn on_storage_withdraw_complete(&mut self, near_op_id: u64) {
        let Some(op) = self.pending_near_ops.remove(&near_op_id) else {
            events::simple("StorageWithdrawAnomaly", JsonObj::new().u64_num("nearOpId", near_op_id));
            return;
        };

        self.storage_withdraw_lock.remove(&op.account);
        let succeeded = matches!(env::promise_result_checked(0, 1024), Ok(_));
        if op.registration_refund {
            self.resolve_registration_refund(near_op_id, op, succeeded);
            return;
        }
        self.total_inflight_storage_near -= op.amount;

        if succeeded {
            events::simple(
                "StorageWithdrawn",
                JsonObj::new()
                    .u64_num("nearOpId", near_op_id)
                    .acc("account", &op.account)
                    .u128_str("amountYocto", op.amount),
            );
            // Fully drained and idle -> start the tracked registration refund (full exit).
            if let Some(p) = self.start_registration_refund(&op.account) {
                p.detach();
            }
        } else {
            // Additive restoration preserves any concurrent storage_deposit() while in flight.
            // The record always still exists here (it is never removed while a withdrawal is in flight).
            self.credit_storage(&op.account, op.amount);
            events::simple(
                "StorageWithdrawFailed",
                JsonObj::new()
                    .u64_num("nearOpId", near_op_id)
                    .acc("account", &op.account)
                    .u128_str("amountYocto", op.amount),
            );
        }
    }

    /// Flag an abnormal/stuck native-NEAR withdrawal after 100 blocks without crediting or removing it.
    #[payable]
    pub fn flag_stuck_near_op(&mut self, near_op_id: u64, note: String) {
        assert_one_yocto();
        self.require_admin();
        let op = self.pending_near_ops.get_mut(&near_op_id).expect("ERR_UNKNOWN_NEAR_OP");
        require!(
            env::block_height() >= op.created_at_block + 100,
            "ERR_STUCK_THRESHOLD_NOT_REACHED"
        );
        op.flagged_stuck = true;
        events::simple(
            "StuckNearOpFlagged",
            JsonObj::new()
                .u64_num("nearOpId", near_op_id)
                .acc("account", &op.account)
                .u128_str("amountYocto", op.amount)
                .u64_num("createdAtBlock", op.created_at_block)
                .str("note", &note),
        );
    }

    /// Adjust provisional `job_storage_deposit` per §9.3: increases apply immediately; decreases use 2-day timelock.
    #[payable]
    pub fn set_job_storage_deposit(&mut self, new_deposit: U128) {
        assert_one_yocto();
        self.require_admin();
        let val = new_deposit.0;
        require!(val > 0, "ERR_ZERO_AMOUNT");
        if val >= self.job_storage_deposit {
            self.pending_job_storage_deposit = None;
            self.storage_deposit_lower_executable_at = 0;
            self.job_storage_deposit = val;
            events::simple("JobStorageDepositSet", JsonObj::new().u128_str("amountYocto", val));
        } else {
            let exec_at = crate::block_timestamp_sec() + TIMELOCK_DELAY_SEC;
            self.pending_job_storage_deposit = Some(val);
            self.storage_deposit_lower_executable_at = exec_at;
            events::simple(
                "JobStorageDepositLowerQueued",
                JsonObj::new().u128_str("amountYocto", val).u64_num("executableAt", exec_at),
            );
        }
    }

    #[payable]
    pub fn execute_job_storage_deposit_lower(&mut self) {
        assert_one_yocto();
        self.require_admin();
        let val = self.pending_job_storage_deposit.expect("ERR_NO_LOWER_QUEUED");
        require!(
            crate::block_timestamp_sec() >= self.storage_deposit_lower_executable_at,
            "ERR_TIMELOCKED"
        );
        self.pending_job_storage_deposit = None;
        self.storage_deposit_lower_executable_at = 0;
        self.job_storage_deposit = val;
        events::simple("JobStorageDepositSet", JsonObj::new().u128_str("amountYocto", val));
    }

    /// Returns the in-flight `near_op_id` holding the per-account storage-withdraw lock, if any.
    pub fn storage_withdraw_lock_of(&self, account_id: AccountId) -> Option<u64> {
        self.storage_withdraw_lock.get(&account_id).copied()
    }

    pub fn storage_credit_of(&self, account_id: AccountId) -> U128 {
        U128(self.storage_credits.get(&account_id).map(|e| e.balance).unwrap_or(0))
    }

    /// Refundable registration held for `account_id`'s credit record (0 if unregistered).
    pub fn storage_registration_of(&self, account_id: AccountId) -> U128 {
        U128(self.storage_credits.get(&account_id).map(|e| e.registration).unwrap_or(0))
    }

    pub fn job_storage_deposit(&self) -> U128 {
        U128(self.job_storage_deposit)
    }
}
