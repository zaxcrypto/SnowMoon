//! FloatPool module: symmetric virtual-offset LP vault, advance issuance, repayment & write-off (POD-01A, POD-04B, POD-05B).
use crate::events;
use crate::math::{
    self, BPS, FEE_BPS, MIN_DEPOSIT_USDC, ORG_EXPOSURE_CAP_BPS, RESERVE_CUT_BPS,
    UTILIZATION_CAP_BPS,
};
use crate::storage_credits::LP_SHARE_STAKE;
use crate::types::{
    Advance, AdvanceStatus, AdvanceView, Hex32, JobStatus, PendingOpKind, ShareEntry,
};
use crate::{block_timestamp_sec, Contract, ContractExt, MIN_PREPAID_GAS_PAYOUT};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, Promise, PromiseOrValue};

impl Contract {
    fn current_advance_rate(&self, org: &AccountId) -> u16 {
        let c = self.org_credit.get(org).cloned().unwrap_or_default();
        math::advance_rate(c.accepted_jobs, c.written_off_jobs)
    }

    fn maybe_reset_epoch(&mut self) {
        if self.total_assets == 0 && self.total_shares > 0 {
            self.total_shares = 0;
            self.share_epoch += 1;
            events::simple("PoolEpochReset", json!({"newEpoch": self.share_epoch}));
        }
    }

    pub(crate) fn handle_deposit_pool(
        &mut self,
        sender_id: AccountId,
        assets: u128,
        receiver: Option<AccountId>,
    ) -> PromiseOrValue<U128> {
        require!(!self.pool_paused, "ERR_POOL_PAUSED");
        require!(
            !self.deposit_allowlist_enabled || self.allowed_depositors.contains(&sender_id),
            "ERR_DEPOSITOR_NOT_ALLOWED"
        );
        require!(assets >= MIN_DEPOSIT_USDC, "ERR_BELOW_MIN_DEPOSIT");

        let shares = math::preview_deposit(assets, self.total_assets, self.total_shares);
        require!(shares > 0, "ERR_ZERO_SHARES");

        let recipient = receiver.unwrap_or_else(|| sender_id.clone());
        let key = (self.share_epoch, recipient.clone());
        // Decision 3: a new share entry is funded by sender_id's storage credits, validated before any write.
        // LP_SHARE_STAKE reserves ALL of the entry's exit storage (entry + one exit op + two claim slots).
        // On failure ft_on_transfer panics and the NEP-141 token refunds the USDC to the sender.
        let mut stake_charged = 0u128;
        if !self.shares_of.contains_key(&key) {
            self.debit_storage_exact(&sender_id, LP_SHARE_STAKE, "ERR_INSUFFICIENT_STORAGE_CREDIT");
            self.total_storage_locked = self
                .total_storage_locked
                .checked_add(LP_SHARE_STAKE)
                .expect("ERR_TOTAL_LOCKED_OVERFLOW");
            self.shares_of.insert(
                key.clone(),
                ShareEntry { storage_stake: LP_SHARE_STAKE, ..Default::default() },
            );
            stake_charged = LP_SHARE_STAKE;
        }
        let entry = self.shares_of.get_mut(&key).unwrap();
        entry.shares = entry.shares.checked_add(shares).expect("ERR_SHARES_OVERFLOW");
        self.total_shares = self
            .total_shares
            .checked_add(shares)
            .expect("ERR_SHARES_OVERFLOW");
        self.total_assets = self
            .total_assets
            .checked_add(assets)
            .expect("ERR_ASSETS_OVERFLOW");

        // Decision 3 condition 1: disclose who paid the storage stake and who owns (and is refunded) it.
        events::simple(
            "Deposited",
            json!({"lp": recipient, "epoch": self.share_epoch,
                   "assetsAtomic": assets.to_string(), "shares": shares.to_string(),
                   "storageStakePayer": sender_id, "storageStakeOwner": recipient,
                   "storageStakeChargedYocto": stake_charged.to_string()}),
        );
        PromiseOrValue::Value(U128(0))
    }

    /// Exit (withdraw/redeem). Decision 3: never requires NEAR at withdrawal time and is never paused.
    /// One exit in flight per LP. An exit to an external receiver needs the external claim slot to be free
    /// (it funds a claim entry if that payout fails); an exit to the LP itself is always available.
    fn exit_pool_shares(
        &mut self,
        lp: AccountId,
        shares: u128,
        assets: u128,
        receiver: Option<AccountId>,
    ) -> Promise {
        let epoch = self.share_epoch;
        let key = (epoch, lp.clone());
        let entry = self.shares_of.get(&key).cloned().unwrap_or_default();
        require!(shares <= entry.shares, "ERR_INSUFFICIENT_SHARES");
        require!(entry.active_exit_op.is_none(), "ERR_EXIT_IN_FLIGHT");
        let idle = self.total_assets.saturating_sub(self.total_outstanding);
        require!(assets <= idle, "ERR_INSUFFICIENT_LIQUIDITY");
        let to = receiver.unwrap_or_else(|| lp.clone());
        if to != lp {
            require!(!entry.external_slot_used, "ERR_EXTERNAL_CLAIM_SLOT_BUSY");
        }

        self.total_shares -= shares;
        self.total_assets -= assets;
        let (op_id, p) =
            self.spawn_usdc_payout(PendingOpKind::LpWithdraw { lp: lp.clone(), epoch }, to, assets);
        // The entry (even at 0 shares) is kept until this op resolves; its stake funds the op's bytes.
        let e = self.shares_of.get_mut(&key).unwrap();
        e.shares -= shares;
        e.active_exit_op = Some(op_id);
        self.maybe_reset_epoch();
        p
    }

    /// Remove an idle share entry with no shares, refunding the stake it still holds to its owner.
    /// Slot stakes currently funding claim entries stay with those entries and are refunded when they close.
    pub(crate) fn maybe_release_share_entry(&mut self, epoch: u64, lp: &AccountId) {
        let key = (epoch, lp.clone());
        let releasable = self
            .shares_of
            .get(&key)
            .map(|e| e.active_exit_op.is_none() && (e.shares == 0 || epoch < self.share_epoch))
            .unwrap_or(false);
        if releasable {
            let entry = self.shares_of.remove(&key).unwrap();
            self.release_locked_storage(lp, entry.storage_stake);
            events::simple(
                "ShareEntryReleased",
                json!({"lp": lp, "epoch": epoch, "storageRefundedYocto": entry.storage_stake.to_string()}),
            );
        }
    }

    /// Synchronously repay an open `Issued` advance before paying operator net. Returns `principal + fee` (or `0`).
    pub(crate) fn repay_advance_internal(&mut self, job_id: &Hex32) -> u128 {
        let Some(adv) = self.advances.get_mut(job_id) else {
            return 0;
        };
        if adv.status == AdvanceStatus::None {
            return 0;
        }
        require!(adv.status == AdvanceStatus::Issued, "ERR_ADVANCE_NOT_ISSUED");

        let principal = adv.principal;
        let fee = adv.fee;
        let org = adv.operator_org.clone();
        adv.status = AdvanceStatus::Repaid;

        let to_reserve = fee * RESERVE_CUT_BPS / BPS;
        self.reserve = self.reserve.checked_add(to_reserve).expect("ERR_RESERVE_OVERFLOW");
        self.total_assets = self
            .total_assets
            .checked_add(fee - to_reserve)
            .expect("ERR_ASSETS_OVERFLOW");
        self.total_outstanding -= principal;

        let oc = self.org_credit.entry(org.clone()).or_default();
        oc.outstanding -= principal;
        // AUD-06: saturate at u32::MAX (rate is already clamped at CAP_BPS long before this).
        oc.accepted_jobs = oc.accepted_jobs.saturating_add(1);

        events::advance_repaid(job_id, principal, fee, to_reserve);
        let new_rate = self.current_advance_rate(&org);
        events::rate_changed(&org, new_rate);
        principal + fee
    }

    /// Synchronously write off an `Issued` advance through the 3-stage loss waterfall (bond -> reserve -> LP).
    pub(crate) fn write_off_internal(&mut self, job_id: &Hex32) {
        let Some(adv) = self.advances.get_mut(job_id) else {
            return;
        };
        if adv.status != AdvanceStatus::Issued {
            return;
        }

        let loss = adv.principal;
        let org = adv.operator_org.clone();
        adv.status = AdvanceStatus::WrittenOff;

        self.total_outstanding -= loss;
        self.total_written_off = self
            .total_written_off
            .checked_add(loss)
            .expect("ERR_WRITTEN_OFF_OVERFLOW");

        let oc = self.org_credit.entry(org.clone()).or_default();
        oc.outstanding -= loss;
        // AUD-06: saturate at u32::MAX (rate is already clamped at FLOOR_BPS long before this).
        oc.written_off_jobs = oc.written_off_jobs.saturating_add(1);

        // Stage 1: Operator bond (0 until P1)
        let bond_slashed = 0u128;
        events::simple("BondSlashed", json!({"jobId": job_id.to_hex(), "amountAtomic": "0"}));

        let remaining = loss - bond_slashed;
        // Stage 2: First-loss reserve
        let reserve_used = remaining.min(self.reserve);
        self.reserve -= reserve_used;
        events::simple(
            "ReserveDrawn",
            json!({"jobId": job_id.to_hex(), "amountAtomic": reserve_used.to_string()}),
        );

        // Stage 3: Socialized LP loss
        let socialized = remaining - reserve_used;
        self.total_assets = self
            .total_assets
            .checked_sub(socialized)
            .expect("ERR_ASSETS_UNDERFLOW");
        events::simple(
            "LossSocialized",
            json!({"jobId": job_id.to_hex(), "amountAtomic": socialized.to_string()}),
        );

        self.maybe_reset_epoch();

        events::advance_written_off(job_id, bond_slashed, reserve_used, socialized);
        let new_rate = self.current_advance_rate(&org);
        events::rate_changed(&org, new_rate);
    }
}

#[near]
impl Contract {
    /// Request an advance against a Funded job (POD-01A, POD-02A, POD-05B).
    pub fn request_advance(&mut self, job_id: Hex32, expected_principal: U128) -> Promise {
        require!(!self.pool_paused, "ERR_POOL_PAUSED");
        require!(
            self.max_total_exposure > 0 && self.max_advance > 0,
            "ERR_CAP_NOT_SET"
        );
        require!(env::prepaid_gas() >= MIN_PREPAID_GAS_PAYOUT, "ERR_INSUFFICIENT_GAS");

        let caller = env::predecessor_account_id();
        let job = self.jobs.get(&job_id).expect("ERR_UNKNOWN_JOB");
        require!(caller == job.operator, "ERR_NOT_OPERATOR");
        require!(job.status == JobStatus::Funded, "ERR_JOB_NOT_FUNDED"); // POD-01A
        require!(!self.advances.contains_key(&job_id), "ERR_DUPLICATE_ADVANCE");

        let org = job.operator.clone();
        let customer_payment = job.customer_payment;
        let rate_bps = self.current_advance_rate(&org);
        let principal = customer_payment * rate_bps as u128 / BPS;
        require!(principal > 0, "ERR_ZERO_AMOUNT");
        require!(principal == expected_principal.0, "ERR_PRINCIPAL_MISMATCH"); // POD-05B

        let fee = principal * FEE_BPS / BPS;

        // 4 lending caps + liquidity
        require!(principal <= self.max_advance, "ERR_ADVANCE_TOO_LARGE");
        let idle = self.total_assets.saturating_sub(self.total_outstanding);
        require!(principal <= idle, "ERR_INSUFFICIENT_LIQUIDITY");

        let new_total_outstanding = self
            .total_outstanding
            .checked_add(principal)
            .expect("ERR_OUTSTANDING_OVERFLOW");
        require!(
            new_total_outstanding
                .checked_add(self.total_written_off)
                .expect("ERR_EXPOSURE_OVERFLOW")
                <= self.max_total_exposure,
            "ERR_EXPOSURE_CAP_EXCEEDED"
        );

        let cur_org_out = self
            .org_credit
            .get(&org)
            .map(|c| c.outstanding)
            .unwrap_or(0);
        let new_org_out = cur_org_out + principal;
        require!(
            math::mul_div_ceil(new_org_out, BPS, self.total_assets.max(1)) <= ORG_EXPOSURE_CAP_BPS
                && self.total_assets > 0,
            "ERR_ORG_CAP_EXCEEDED"
        );
        require!(
            math::mul_div_ceil(new_total_outstanding, BPS, self.total_assets) <= UTILIZATION_CAP_BPS,
            "ERR_UTILIZATION_CAP_EXCEEDED"
        );

        self.total_outstanding = new_total_outstanding;
        self.org_credit.entry(org.clone()).or_default().outstanding = new_org_out;

        let (op_id, promise) =
            self.spawn_usdc_payout(PendingOpKind::AdvancePayout { job_id }, org.clone(), principal);

        self.advances.insert(
            job_id,
            Advance {
                job_id,
                operator_org: org,
                principal,
                fee,
                rate_bps,
                opened_at: block_timestamp_sec(),
                status: AdvanceStatus::PayoutPending,
                active_op_id: Some(op_id),
            },
        );
        promise
    }

    #[payable]
    pub fn withdraw(&mut self, assets: U128, receiver: Option<AccountId>) -> Promise {
        assert_one_yocto();
        require!(assets.0 > 0, "ERR_ZERO_AMOUNT");
        let shares = math::preview_withdraw(assets.0, self.total_assets, self.total_shares);
        self.exit_pool_shares(env::predecessor_account_id(), shares, assets.0, receiver)
    }

    #[payable]
    pub fn redeem(&mut self, shares: U128, receiver: Option<AccountId>) -> Promise {
        assert_one_yocto();
        require!(shares.0 > 0, "ERR_ZERO_SHARES");
        let assets = math::preview_redeem(shares.0, self.total_assets, self.total_shares);
        require!(assets > 0, "ERR_ZERO_ASSETS");
        self.exit_pool_shares(env::predecessor_account_id(), shares.0, assets, receiver)
    }

    // ───── Pool views ─────
    pub fn preview_deposit(&self, assets: U128) -> U128 {
        U128(math::preview_deposit(assets.0, self.total_assets, self.total_shares))
    }
    pub fn preview_withdraw(&self, assets: U128) -> U128 {
        U128(math::preview_withdraw(assets.0, self.total_assets, self.total_shares))
    }
    pub fn preview_redeem(&self, shares: U128) -> U128 {
        U128(math::preview_redeem(shares.0, self.total_assets, self.total_shares))
    }
    pub fn share_price_wad(&self) -> U128 {
        U128(math::share_price_wad(self.total_assets, self.total_shares))
    }
    pub fn advance_rate(&self, org: AccountId) -> u16 {
        self.current_advance_rate(&org)
    }
    pub fn shares_of(&self, lp: AccountId) -> U128 {
        U128(self.shares_of.get(&(self.share_epoch, lp)).map(|e| e.shares).unwrap_or(0))
    }

    /// Decision 5: after an epoch reset, an LP removes its worthless stale-epoch entry and recovers its stake.
    pub fn release_stale_share_entry(&mut self, epoch: u64) {
        require!(epoch < self.share_epoch, "ERR_EPOCH_NOT_STALE");
        let lp = env::predecessor_account_id();
        let e = self.shares_of.get(&(epoch, lp.clone())).expect("ERR_NO_SHARE_ENTRY");
        require!(e.active_exit_op.is_none(), "ERR_EXIT_IN_FLIGHT");
        self.maybe_release_share_entry(epoch, &lp);
    }

    /// Storage stake held by `lp`'s share entry in the current epoch.
    pub fn share_storage_stake_of(&self, lp: AccountId) -> U128 {
        U128(self.shares_of.get(&(self.share_epoch, lp)).map(|e| e.storage_stake).unwrap_or(0))
    }
    pub fn get_advance(&self, job_id: Hex32) -> Option<AdvanceView> {
        self.advances.get(&job_id).map(|a| AdvanceView {
            job_id: a.job_id,
            operator_org: a.operator_org.clone(),
            principal: U128(a.principal),
            fee: U128(a.fee),
            rate_bps: a.rate_bps,
            opened_at: a.opened_at,
            status: a.status,
            active_op_id: a.active_op_id,
        })
    }
}
