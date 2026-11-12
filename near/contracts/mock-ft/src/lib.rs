//! TEST-ONLY minimal NEP-141 + NEP-145 mock USDC (6 decimals) for NEAR Sandbox tests.
//! Accounts must call `storage_deposit` to register before `ft_transfer` can succeed (matching real USDC).
use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas,
    NearToken, PanicOnDefault, PromiseOrValue,
};

const GAS_ON_TRANSFER: Gas = Gas::from_tgas(40);
const GAS_RESOLVE: Gas = Gas::from_tgas(10);

#[ext_contract(ext_receiver)]
pub trait ExtFtReceiver {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128>;
}

#[derive(BorshStorageKey, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
pub enum Key {
    Balances,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockFt {
    pub owner: AccountId,
    pub total_supply: u128,
    pub balances: LookupMap<AccountId, u128>,
}

#[near]
impl MockFt {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            total_supply: 0,
            balances: LookupMap::new(Key::Balances),
        }
    }

    /// Test helper: register + mint atomic units.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        let cur = self.balances.get(&account_id).copied().unwrap_or(0);
        self.balances.insert(account_id, cur + amount.0);
        self.total_supply += amount.0;
    }

    /// Standard NEP-145 registration (inserts `0` balance so transfers can land).
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) {
        let acc = account_id.unwrap_or_else(env::predecessor_account_id);
        if !self.balances.contains_key(&acc) {
            self.balances.insert(acc, 0);
        }
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, _memo: Option<String>) {
        assert_one_yocto();
        let sender = env::predecessor_account_id();
        self.internal_transfer(&sender, &receiver_id, amount.0);
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        _memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        assert_one_yocto();
        let sender = env::predecessor_account_id();
        self.internal_transfer(&sender, &receiver_id, amount.0);
        ext_receiver::ext(receiver_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(0))
            .with_static_gas(GAS_ON_TRANSFER)
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_RESOLVE)
                    .ft_resolve_transfer(sender, receiver_id, amount),
            )
            .into()
    }

    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let unused = match env::promise_result_checked(0, 256) {
            Ok(bytes) => near_sdk::serde_json::from_slice::<U128>(&bytes)
                .map(|v| v.0.min(amount.0))
                .unwrap_or(0),
            Err(_) => amount.0, // Receiver panicked -> refund full amount to sender
        };
        if unused > 0 {
            let r_bal = self.balances.get(&receiver_id).copied().unwrap_or(0);
            let refund = unused.min(r_bal);
            if refund > 0 {
                self.balances.insert(receiver_id, r_bal - refund);
                let s_bal = self.balances.get(&sender_id).copied().unwrap_or(0);
                self.balances.insert(sender_id, s_bal + refund);
            }
            return U128(amount.0 - refund);
        }
        amount
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn is_registered(&self, account_id: AccountId) -> bool {
        self.balances.contains_key(&account_id)
    }

    fn internal_transfer(&mut self, sender: &AccountId, receiver: &AccountId, amount: u128) {
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        let s_bal = self.balances.get(sender).copied().expect("ERR_SENDER_UNREGISTERED");
        require!(s_bal >= amount, "ERR_INSUFFICIENT_BALANCE");
        // Strictly enforce registration so unregistered-receiver tests trigger promise failure!
        let r_bal = self.balances.get(receiver).copied().expect("ERR_RECEIVER_UNREGISTERED");
        self.balances.insert(sender.clone(), s_bal - amount);
        self.balances.insert(receiver.clone(), r_bal + amount);
    }
}
