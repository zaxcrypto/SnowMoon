//! Governance module: pause circuit breakers, 2-day timelocked cap raises & admin transfers, allowlists.
use crate::events;
use crate::{block_timestamp_sec, Contract, ContractExt, TIMELOCK_DELAY_SEC};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{assert_one_yocto, env, near, require, AccountId};

impl Contract {
    pub(crate) fn require_admin(&self) {
        require!(env::predecessor_account_id() == self.admin, "ERR_NOT_ADMIN");
    }

    fn apply_caps_internal(&mut self, max_total_exposure: u128, max_advance: u128) {
        self.max_total_exposure = max_total_exposure;
        self.max_advance = max_advance;
        events::simple(
            "CapsSet",
            json!({"maxTotalExposure": max_total_exposure.to_string(), "maxAdvance": max_advance.to_string()}),
        );
    }

    fn clear_cap_raise(&mut self) {
        self.pending_max_total_exposure = 0;
        self.pending_max_advance = 0;
        self.cap_raise_executable_at = 0;
    }
}

#[near]
impl Contract {
    #[payable]
    pub fn set_vault_paused(&mut self, paused: bool) {
        assert_one_yocto();
        self.require_admin();
        self.vault_paused = paused;
        events::simple("VaultPauseSet", json!({"paused": paused}));
    }

    #[payable]
    pub fn set_pool_paused(&mut self, paused: bool) {
        assert_one_yocto();
        self.require_admin();
        self.pool_paused = paused;
        events::simple("PoolPauseSet", json!({"paused": paused}));
    }

    #[payable]
    pub fn set_max_job_payment(&mut self, max_job_payment: U128) {
        assert_one_yocto();
        self.require_admin();
        require!(max_job_payment.0 > 0, "ERR_ZERO_AMOUNT");
        self.max_job_payment = max_job_payment.0;
        events::simple(
            "MaxJobPaymentSet",
            json!({"maxJobPayment": max_job_payment.0.to_string()}),
        );
    }

    /// Configure exposure & single-advance caps (FloatPool.sol:182).
    /// First configuration or lowering applies immediately; raises queue for 2 days; mixed raise+lower reverts.
    #[payable]
    pub fn set_caps(&mut self, max_total_exposure: U128, max_advance: U128) {
        assert_one_yocto();
        self.require_admin();
        let e = max_total_exposure.0;
        let a = max_advance.0;
        require!(e > 0 && a > 0, "ERR_ZERO_AMOUNT");

        let configured = self.max_total_exposure != 0;
        let raises = e > self.max_total_exposure || a > self.max_advance;
        let lowers = e < self.max_total_exposure || a < self.max_advance;
        require!(!(configured && raises && lowers), "ERR_MIXED_CAP_CHANGE");

        if configured && raises {
            let executable_at = block_timestamp_sec() + TIMELOCK_DELAY_SEC;
            self.pending_max_total_exposure = e;
            self.pending_max_advance = a;
            self.cap_raise_executable_at = executable_at;
            events::simple(
                "CapsRaiseQueued",
                json!({"maxTotalExposure": e.to_string(), "maxAdvance": a.to_string(), "executableAt": executable_at}),
            );
            return;
        }

        if self.cap_raise_executable_at != 0 {
            self.clear_cap_raise();
            events::simple("CapsRaiseCancelled", json!({}));
        }
        self.apply_caps_internal(e, a);
    }

    #[payable]
    pub fn execute_caps_raise(&mut self) {
        assert_one_yocto();
        self.require_admin();
        let exec_at = self.cap_raise_executable_at;
        require!(exec_at != 0, "ERR_NO_CAP_RAISE_QUEUED");
        require!(block_timestamp_sec() >= exec_at, "ERR_CAP_RAISE_TIMELOCKED");
        let e = self.pending_max_total_exposure;
        let a = self.pending_max_advance;
        self.clear_cap_raise();
        self.apply_caps_internal(e, a);
    }

    #[payable]
    pub fn cancel_caps_raise(&mut self) {
        assert_one_yocto();
        self.require_admin();
        require!(self.cap_raise_executable_at != 0, "ERR_NO_CAP_RAISE_QUEUED");
        self.clear_cap_raise();
        events::simple("CapsRaiseCancelled", json!({}));
    }

    #[payable]
    pub fn set_deposit_allowlist_enabled(&mut self, enabled: bool) {
        assert_one_yocto();
        self.require_admin();
        self.deposit_allowlist_enabled = enabled;
        events::simple("DepositAllowlistSet", json!({"enabled": enabled}));
    }

    #[payable]
    pub fn set_depositor_allowed(&mut self, account: AccountId, allowed: bool) {
        assert_one_yocto();
        self.require_admin();
        if allowed {
            self.allowed_depositors.insert(account.clone());
        } else {
            self.allowed_depositors.remove(&account);
        }
        events::simple(
            "DepositorAllowed",
            json!({"depositor": account, "allowed": allowed}),
        );
    }

    #[payable]
    pub fn set_relayer_allowed(&mut self, account: AccountId, allowed: bool) {
        assert_one_yocto();
        self.require_admin();
        if allowed {
            self.allowed_relayers.insert(account.clone());
        } else {
            self.allowed_relayers.remove(&account);
        }
        events::simple(
            "RelayerAllowed",
            json!({"relayer": account, "allowed": allowed}),
        );
    }

    #[payable]
    pub fn transfer_admin(&mut self, new_admin: AccountId) {
        assert_one_yocto();
        self.require_admin();
        if new_admin == self.admin {
            self.pending_admin = None;
            self.admin_transfer_acceptable_at = 0;
            events::simple("AdminTransferCancelled", json!({}));
            return;
        }
        let acceptable_at = block_timestamp_sec() + TIMELOCK_DELAY_SEC;
        let current = self.admin.clone();
        self.pending_admin = Some(new_admin.clone());
        self.admin_transfer_acceptable_at = acceptable_at;
        events::simple(
            "AdminTransferStarted",
            json!({"currentAdmin": current, "pendingAdmin": new_admin, "acceptableAt": acceptable_at}),
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
            block_timestamp_sec() >= self.admin_transfer_acceptable_at,
            "ERR_ADMIN_TRANSFER_TIMELOCKED"
        );
        let prev = self.admin.clone();
        self.admin = caller.clone();
        self.pending_admin = None;
        self.admin_transfer_acceptable_at = 0;
        events::simple(
            "AdminTransferred",
            json!({"previousAdmin": prev, "newAdmin": caller}),
        );
    }

    pub fn admin(&self) -> AccountId {
        self.admin.clone()
    }
}

