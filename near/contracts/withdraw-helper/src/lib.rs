//! TEST-ONLY Sandbox helper for T-27 (FC-02). Never deploy outside NEAR Sandbox.
//!
//! In one receipt it schedules, from this account:
//!   1. `core.storage_withdraw(amount)`  -> core deducts credits and sends `Promise::transfer` back to us,
//!   2. `core.storage_deposit(self)`     -> a concurrent deposit that lands while the withdrawal is in flight,
//!   3. `DeleteAccount(self)`            -> this account no longer exists when core's NEAR transfer arrives.
//! Receipts 1-3 execute in the next block; core's transfer receipt executes one block later and fails with
//! `AccountDoesNotExist`, so `on_storage_withdraw_complete` observes `PromiseResult::Failed`.
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise};

#[near(contract_state)]
#[derive(Default)]
pub struct WithdrawHelper {}

#[near]
impl WithdrawHelper {
    pub fn withdraw_deposit_and_self_destruct(
        &mut self,
        core: AccountId,
        withdraw_yocto: U128,
        deposit_yocto: U128,
        beneficiary: AccountId,
    ) {
        let me = env::current_account_id();
        Promise::new(core.clone())
            .function_call(
                "storage_withdraw".to_string(),
                json!({"amount": withdraw_yocto.0.to_string()}).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                Gas::from_tgas(40),
            )
            .detach();
        Promise::new(core)
            .function_call(
                "storage_deposit".to_string(),
                json!({"account_id": me}).to_string().into_bytes(),
                NearToken::from_yoctonear(deposit_yocto.0),
                Gas::from_tgas(15),
            )
            .detach();
        Promise::new(me).delete_account(beneficiary).detach();
    }
}

