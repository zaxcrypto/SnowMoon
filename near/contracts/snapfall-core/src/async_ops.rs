//! Async NEP-141 outbound transfers, callbacks, pull-claims, and non-crediting stuck-op flags (MC-03, MC-06, FC-03).
use crate::events;
use crate::storage_credits::LP_CLAIM_SLOT_STAKE;
use crate::types::{AdvanceStatus, ClaimEntry, JobStatus, PendingOp, PendingOpKind, PendingOpView};
use crate::{ext_ft, Contract, ContractExt, GAS_FT_TRANSFER, GAS_PAYOUT_CALLBACK};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, NearToken, Promise};

impl Contract {
    /// Allocate a monotonic `op_id`, record `PendingOp`, increment `total_in_flight_usdc`,
    /// and dispatch `usdc.ft_transfer(recipient, amount).then(on_payout_complete(op_id))`.
    pub(crate) fn spawn_usdc_payout(
        &mut self,
        kind: PendingOpKind,
        recipient: AccountId,
        amount: u128,
    ) -> (u64, Promise) {
        require!(amount > 0, "ERR_ZERO_PAYOUT");
        let op_id = self.next_op_id;
        self.next_op_id += 1;

        self.total_in_flight_usdc = self
            .total_in_flight_usdc
            .checked_add(amount)
            .expect("ERR_INFLIGHT_OVERFLOW");
        self.pending_ops.insert(
            op_id,
            PendingOp {
                op_id,
                kind,
                recipient: recipient.clone(),
                amount,
                created_at_block: env::block_height(),
                created_at_sec: crate::block_timestamp_sec(),
                flagged_stuck: false,
            },
        );

        let promise = ext_ft::ext(self.usdc_token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(recipient, U128(amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_PAYOUT_CALLBACK)
                    .on_payout_complete(op_id),
            );
        (op_id, promise)
    }

    /// Additive credit to pull-claim fallback ledger (never overwrites existing claimable balances).
    /// `new_entry_stake` / `payer` fund the entry's bytes only when this credit creates a new entry.
    pub(crate) fn credit_claimable(
        &mut self,
        beneficiary: &AccountId,
        amount: u128,
        op_id: u64,
        new_entry_stake: u128,
        payer: Option<(u64, AccountId)>,
    ) {
        let entry = self.claimable_usdc.entry(beneficiary.clone()).or_insert(ClaimEntry {
            balance: 0,
            active_op: None,
            storage_stake: new_entry_stake,
            storage_payer: payer,
        });
        entry.balance = entry.balance.checked_add(amount).expect("ERR_CLAIMABLE_OVERFLOW");
        self.total_claimable_usdc = self
            .total_claimable_usdc
            .checked_add(amount)
            .expect("ERR_TOTAL_CLAIMABLE_OVERFLOW");
        events::simple(
            "ClaimableCredited",
            json!({"opId": op_id, "account": beneficiary, "amountAtomic": amount.to_string()}),
        );
    }

    /// Remove a claimable entry once it is empty and has no in-flight claim. Its storage stake goes back to
    /// exactly the party that funded it: the LP share entry's slot if that entry still exists, otherwise the
    /// LP's storage credits. Job-funded entries (stake 0) simply disappear.
    fn maybe_remove_claim_entry(&mut self, owner: &AccountId) {
        let removable = self
            .claimable_usdc
            .get(owner)
            .map(|e| e.balance == 0 && e.active_op.is_none())
            .unwrap_or(false);
        if !removable {
            return;
        }
        let e = self.claimable_usdc.remove(owner).unwrap();
        if e.storage_stake == 0 {
            return;
        }
        match e.storage_payer {
            Some((epoch, lp)) => {
                let key = (epoch, lp.clone());
                if let Some(share) = self.shares_of.get_mut(&key) {
                    // Return the slot to the LP's share entry (stays locked, slot free again).
                    share.storage_stake += e.storage_stake;
                    if *owner == lp {
                        share.self_slot_used = false;
                    } else {
                        share.external_slot_used = false;
                    }
                    self.maybe_release_share_entry(epoch, &lp);
                } else {
                    self.release_locked_storage(&lp, e.storage_stake);
                }
            }
            None => self.release_locked_storage(owner, e.storage_stake),
        }
    }
}

#[near]
impl Contract {
    /// Sole authority allowed to resolve `PendingOp` and decrement `total_in_flight_usdc`.
    /// Allocates 45 TGas (defensive, NOT a guarantee; see §7.4 if callback panics/OOGs).
    #[private]
    pub fn on_payout_complete(&mut self, op_id: u64) {
        #[cfg(feature = "test-fail-callback")]
        if self.test_force_payout_callback_panic {
            env::panic_str("TEST_FORCED_CALLBACK_PANIC");
        }

        let Some(op) = self.pending_ops.remove(&op_id) else {
            events::simple("PayoutCallbackAnomaly", json!({"opId": op_id}));
            return;
        };

        self.total_in_flight_usdc -= op.amount;
        if op.flagged_stuck {
            self.flagged_stuck_count = self.flagged_stuck_count.saturating_sub(1);
        }

        let succeeded = matches!(env::promise_result_checked(0, 1024), Ok(_));
        let via = if succeeded { "direct" } else { "claimable" };

        if !succeeded {
            let claim_owner = match &op.kind {
                PendingOpKind::Claim { owner } => owner.clone(),
                _ => op.recipient.clone(),
            };
            // Decision 3: a NEW claim entry created by a failed LP payout is funded by one of the LP's
            // pre-reserved claim slots (self slot if paid to the LP itself, external slot otherwise).
            let mut stake = 0u128;
            let mut payer = None;
            if let PendingOpKind::LpWithdraw { lp, epoch } = &op.kind {
                if !self.claimable_usdc.contains_key(&claim_owner) {
                    if let Some(share) = self.shares_of.get_mut(&(*epoch, lp.clone())) {
                        let slot_free = if claim_owner == *lp {
                            !share.self_slot_used
                        } else {
                            !share.external_slot_used
                        };
                        if slot_free && share.storage_stake >= LP_CLAIM_SLOT_STAKE {
                            share.storage_stake -= LP_CLAIM_SLOT_STAKE;
                            if claim_owner == *lp {
                                share.self_slot_used = true;
                            } else {
                                share.external_slot_used = true;
                            }
                            stake = LP_CLAIM_SLOT_STAKE;
                            payer = Some((*epoch, lp.clone()));
                        }
                    }
                }
            }
            self.credit_claimable(&claim_owner, op.amount, op_id, stake, payer);
        }

        match op.kind {
            PendingOpKind::AdvancePayout { job_id } => {
                if let Some(adv) = self.advances.get_mut(&job_id) {
                    adv.status = AdvanceStatus::Issued;
                    adv.active_op_id = None;
                    let org = adv.operator_org.clone();
                    let principal = adv.principal;
                    let fee = adv.fee;
                    let rate_bps = adv.rate_bps;
                    events::advance_issued(&job_id, &org, principal, fee, rate_bps, via);
                }
            }
            PendingOpKind::SettlementOperatorPayout {
                job_id,
                advance_repaid,
            } => {
                if let Some(job) = self.jobs.get_mut(&job_id) {
                    job.status = JobStatus::Accepted;
                    job.active_op_id = None;
                }
                events::job_settled(&job_id, advance_repaid, op.amount, via);
            }
            PendingOpKind::RefundCustomer { job_id } => {
                if let Some(job) = self.jobs.get_mut(&job_id) {
                    job.status = JobStatus::Refunded;
                    job.active_op_id = None;
                }
                events::simple(
                    "JobRefunded",
                    json!({"jobId": job_id.to_hex(), "amountAtomic": op.amount.to_string(), "settledVia": via}),
                );
            }
            PendingOpKind::LpWithdraw { lp, epoch } => {
                // Clear this LP's exit lock; release the entry if it is now empty (exact refund of its stake).
                if let Some(share) = self.shares_of.get_mut(&(epoch, lp.clone())) {
                    if share.active_exit_op == Some(op_id) {
                        share.active_exit_op = None;
                    }
                }
                self.maybe_release_share_entry(epoch, &lp);
                events::simple(
                    "Withdrawn",
                    json!({"lp": lp, "recipient": op.recipient, "amountAtomic": op.amount.to_string(), "settledVia": via}),
                );
            }
            PendingOpKind::Claim { owner } => {
                // Decision 4: the owner's claim lock clears only when its own op resolves.
                if let Some(e) = self.claimable_usdc.get_mut(&owner) {
                    if e.active_op == Some(op_id) {
                        e.active_op = None;
                    }
                }
                self.maybe_remove_claim_entry(&owner);
                if succeeded {
                    events::simple(
                        "UsdcClaimed",
                        json!({"owner": owner, "recipient": op.recipient, "amountAtomic": op.amount.to_string()}),
                    );
                } else {
                    events::simple(
                        "ClaimFailed",
                        json!({"opId": op_id, "owner": owner, "amountAtomic": op.amount.to_string()}),
                    );
                }
            }
        }

        if op.flagged_stuck {
            events::simple("StuckOpResolved", json!({"opId": op_id, "outcome": via}));
        }
    }

    /// Pull-claim USDC credited by a failed direct transfer (e.g. unregistered on USDC). Never paused.
    /// Decision 4: at most one in-flight claim per owner; credits arriving meanwhile stay claimable.
    #[payable]
    pub fn claim_usdc(&mut self, amount: Option<U128>, recipient: Option<AccountId>) -> Promise {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        let (avail, in_flight) = self
            .claimable_usdc
            .get(&caller)
            .map(|e| (e.balance, e.active_op.is_some()))
            .unwrap_or((0, false));
        require!(!in_flight, "ERR_CLAIM_IN_FLIGHT");
        let claim_amt = amount.map(|a| a.0).unwrap_or(avail);
        require!(claim_amt > 0 && claim_amt <= avail, "ERR_INSUFFICIENT_CLAIMABLE");

        self.total_claimable_usdc -= claim_amt;
        let to = recipient.unwrap_or_else(|| caller.clone());
        let (op_id, p) =
            self.spawn_usdc_payout(PendingOpKind::Claim { owner: caller.clone() }, to, claim_amt);
        // Entry is kept (even at balance 0) while the claim is in flight so the lock persists.
        let e = self.claimable_usdc.get_mut(&caller).unwrap();
        e.balance -= claim_amt;
        e.active_op = Some(op_id);
        p
    }

    /// Flag a stuck USDC `PendingOp` after 100 blocks and pause entries. NEVER credits or removes `op_id`.
    #[payable]
    pub fn flag_stuck_op(&mut self, op_id: u64, note: String) {
        assert_one_yocto();
        self.require_admin();
        let op = self.pending_ops.get_mut(&op_id).expect("ERR_UNKNOWN_OP");
        require!(
            env::block_height() >= op.created_at_block + 100,
            "ERR_STUCK_THRESHOLD_NOT_REACHED"
        );
        if !op.flagged_stuck {
            op.flagged_stuck = true;
            self.flagged_stuck_count += 1;
        }
        self.vault_paused = true;
        self.pool_paused = true;
        events::simple(
            "StuckOpFlagged",
            json!({"opId": op_id, "recipient": op.recipient, "amountAtomic": op.amount.to_string(),
                   "createdAtBlock": op.created_at_block, "note": note}),
        );
    }

    /// Admin-only recovery for a flagged stuck `AdvancePayout` (`PayoutPending`) operation.
    /// Removes `op_id` from `pending_ops` so `on_payout_complete` cannot duplicate payouts,
    /// optionally credits `claimable_usdc` for pull-claim, and transitions the advance to `Issued`
    /// so `accept_delivery` repays the pool and `refund` still performs 100% customer-first restitution.
    #[payable]
    pub fn resolve_stuck_advance_payout(&mut self, op_id: u64, credit_claimable: bool) {
        assert_one_yocto();
        self.require_admin();
        let existing = self.pending_ops.get(&op_id).expect("ERR_UNKNOWN_OP");
        require!(existing.flagged_stuck, "ERR_OP_NOT_FLAGGED_STUCK");
        require!(
            env::block_height() >= existing.created_at_block + 100,
            "ERR_STUCK_THRESHOLD_NOT_REACHED"
        );
        let job_id = match existing.kind {
            PendingOpKind::AdvancePayout { job_id } => job_id,
            _ => env::panic_str("ERR_NOT_ADVANCE_PAYOUT_OP"),
        };

        let op = self.pending_ops.remove(&op_id).expect("ERR_UNKNOWN_OP");
        self.total_in_flight_usdc = self.total_in_flight_usdc.saturating_sub(op.amount);
        self.flagged_stuck_count = self.flagged_stuck_count.saturating_sub(1);

        if credit_claimable {
            self.credit_claimable(&op.recipient, op.amount, op_id, 0, None);
        }

        let adv = self.advances.get_mut(&job_id).expect("ERR_NO_ADVANCE");
        require!(
            adv.status == AdvanceStatus::PayoutPending && adv.active_op_id == Some(op_id),
            "ERR_ADVANCE_NOT_PAYOUT_PENDING"
        );
        adv.status = AdvanceStatus::Issued;
        adv.active_op_id = None;

        events::advance_issued(
            &job_id,
            &adv.operator_org,
            adv.principal,
            adv.fee,
            adv.rate_bps,
            if credit_claimable {
                "stuck_recovery_claimable"
            } else {
                "stuck_recovery_settled"
            },
        );
    }

    pub fn claimable_of(&self, account_id: AccountId) -> U128 {
        U128(self.claimable_usdc.get(&account_id).map(|e| e.balance).unwrap_or(0))
    }

    /// In-flight claim op id for `account_id`, if any (Decision 4 lock).
    pub fn claim_in_flight_of(&self, account_id: AccountId) -> Option<u64> {
        self.claimable_usdc.get(&account_id).and_then(|e| e.active_op)
    }

    pub fn get_pending_op(&self, op_id: u64) -> Option<PendingOpView> {
        self.pending_ops.get(&op_id).map(|op| PendingOpView {
            op_id: op.op_id,
            kind: op.kind.clone(),
            recipient: op.recipient.clone(),
            amount: U128(op.amount),
            created_at_block: op.created_at_block,
            flagged_stuck: op.flagged_stuck,
        })
    }
}

