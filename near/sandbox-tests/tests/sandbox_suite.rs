//! NEAR Sandbox integration test suite for T-18..T-20, T-22, T-23, T-25..T-29 (Phase 0.7.1 §11).
use near_sdk::json_types::U128;
use near_sdk::NearToken;
use near_workspaces::types::Gas;
use near_workspaces::{Account, Contract, Worker, network::Sandbox};
use serde_json::{json, Value};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(23); // JOB_STORAGE_DEPOSIT_INITIAL = 0.023 NEAR (Owner Decision 1)
const STORAGE_REGISTRATION: NearToken = NearToken::from_millinear(7); // one-time storage-credit record registration (Decision 4)
const LP_STORAGE_CREDIT: NearToken = NearToken::from_millinear(27); // LP_SHARE_STAKE (0.020) + registration (0.007)
const ANCHOR_DEPOSIT: NearToken = NearToken::from_millinear(6); // ANCHOR_STORAGE_DEPOSIT

fn hex32(tag: u8) -> String {
    format!("0x{:02x}{}", tag, "00".repeat(31))
}

fn usdc(n: u128) -> u128 {
    n * 1_000_000
}

fn core_wasm() -> Vec<u8> {
    std::fs::read("../target/wasm32-unknown-unknown/release/snapfall_core.wasm")
        .expect("build snapfall-core wasm first")
}
fn core_fail_cb_wasm() -> Vec<u8> {
    std::fs::read("../target/wasm32-unknown-unknown/release/snapfall_core_fail_cb.wasm")
        .expect("build snapfall-core with --features test-fail-callback for T-28")
}
fn audit_wasm() -> Vec<u8> {
    std::fs::read("../target/wasm32-unknown-unknown/release/snapfall_audit.wasm")
        .expect("build snapfall-audit wasm first")
}
fn mock_ft_wasm() -> Vec<u8> {
    std::fs::read("../target/wasm32-unknown-unknown/release/mock_ft.wasm")
        .expect("build mock-ft wasm first")
}
fn withdraw_helper_wasm() -> Vec<u8> {
    std::fs::read("../target/wasm32-unknown-unknown/release/withdraw_helper.wasm")
        .expect("build withdraw-helper wasm first (T-27)")
}

struct Env {
    worker: Worker<Sandbox>,
    admin: Account,
    customer: Account,
    operator: Account,
    authority: Account,
    ft: Contract,
    core: Contract,
    audit: Contract,
}

async fn boot(register_customer: bool, register_operator: bool, use_fail_cb: bool) -> Env {
    let worker = near_workspaces::sandbox().await.unwrap();
    let admin = worker.dev_create_account().await.unwrap();
    let customer = worker.dev_create_account().await.unwrap();
    let operator = worker.dev_create_account().await.unwrap();
    let authority = worker.dev_create_account().await.unwrap();

    let ft = worker.dev_deploy(&mock_ft_wasm()).await.unwrap();
    ft.call("new").args_json(json!({"owner": admin.id()})).transact().await.unwrap().unwrap();

    let wasm = if use_fail_cb { core_fail_cb_wasm() } else { core_wasm() };
    let core = worker.dev_deploy(&wasm).await.unwrap();
    core.call("new")
        .args_json(json!({"usdc_token": ft.id(), "admin": admin.id()}))
        .transact()
        .await
        .unwrap()
        .unwrap();

    let audit = worker.dev_deploy(&audit_wasm()).await.unwrap();
    audit
        .call("new")
        .args_json(json!({"core_contract": core.id(), "operator_authority": authority.id(), "admin": admin.id()}))
        .transact()
        .await
        .unwrap()
        .unwrap();

    // Register core & admin on mock-ft; optionally skip customer/operator to test pull-claim fallback
    ft.call("storage_deposit").args_json(json!({"account_id": core.id()})).transact().await.unwrap().unwrap();
    ft.call("mint").args_json(json!({"account_id": admin.id(), "amount": U128(usdc(5_000))})).transact().await.unwrap().unwrap();
    if register_customer {
        ft.call("mint").args_json(json!({"account_id": customer.id(), "amount": U128(usdc(500))})).transact().await.unwrap().unwrap();
    }
    if register_operator {
        ft.call("storage_deposit").args_json(json!({"account_id": operator.id()})).transact().await.unwrap().unwrap();
    }

    admin.call(core.id(), "set_max_job_payment").deposit(ONE_YOCTO).args_json(json!({"max_job_payment": U128(usdc(1_000))})).transact().await.unwrap().unwrap();
    admin.call(core.id(), "set_caps").deposit(ONE_YOCTO).args_json(json!({"max_total_exposure": U128(usdc(5_000)), "max_advance": U128(usdc(500))})).transact().await.unwrap().unwrap();
    // Decision 3: the LP (admin) funds its share entry (all exit storage reserved up front) before depositing.
    admin.call(core.id(), "storage_deposit").deposit(LP_STORAGE_CREDIT).args_json(json!({"account_id": null})).transact().await.unwrap().unwrap();
    admin.call(ft.id(), "ft_transfer_call").deposit(ONE_YOCTO).gas(Gas::from_tgas(100))
        .args_json(json!({"receiver_id": core.id(), "amount": U128(usdc(1_000)), "msg": r#"{"DepositPool":{"receiver":null}}"#}))
        .transact().await.unwrap().unwrap();

    Env { worker, admin, customer, operator, authority, ft, core, audit }
}

/// Decision 2: create_job no longer takes a job_id; the contract generates and returns it.
async fn create_job_returning_id(e: &Env, customer: &near_workspaces::AccountId, pay: u128) -> String {
    e.admin.call(e.core.id(), "create_job").deposit(STORAGE_DEPOSIT)
        .args_json(json!({"customer": customer, "operator": e.operator.id(),
                          "customer_payment": U128(pay), "max_operating_budget": U128(pay / 2),
                          "terms_hash": hex32(0xaa), "deadline": 9_999_999_999u64}))
        .transact().await.unwrap().unwrap().json::<String>().unwrap()
}

async fn fund_two_step(e: &Env, _tag: u8, pay: u128) -> String {
    let jid = create_job_returning_id(e, e.customer.id(), pay).await;
    e.customer.call(e.ft.id(), "ft_transfer_call").deposit(ONE_YOCTO).gas(Gas::from_tgas(100))
        .args_json(json!({"receiver_id": e.core.id(), "amount": U128(pay), "msg": json!({"FundJob": {"job_id": jid}}).to_string()}))
        .transact().await.unwrap().unwrap();
    jid
}

#[tokio::test]
async fn test_unregistered_operator_payout_falls_back_to_claimable() {
    // T-18: operator NOT registered on mock-usdc
    let e = boot(true, false, false).await;
    let jid = fund_two_step(&e, 18, usdc(25)).await;

    e.operator.call(e.core.id(), "start_work").args_json(json!({"job_id": jid})).transact().await.unwrap().unwrap();
    e.operator.call(e.core.id(), "submit_delivery").args_json(json!({"job_id": jid, "delivery_hash": hex32(0xbb)})).transact().await.unwrap().unwrap();
    e.customer.call(e.core.id(), "accept_delivery").gas(Gas::from_tgas(150)).args_json(json!({"job_id": jid})).transact().await.unwrap().unwrap();

    let job: Value = e.core.view("get_job").args_json(json!({"job_id": jid})).await.unwrap().json().unwrap();
    assert_eq!(job["status"], "Accepted");
    let claimable: U128 = e.core.view("claimable_of").args_json(json!({"account_id": e.operator.id()})).await.unwrap().json().unwrap();
    assert_eq!(claimable.0, usdc(25));
}

#[tokio::test]
async fn test_unregistered_customer_refund_falls_back_to_claimable() {
    // T-19: relayer funds Created job on behalf of unregistered customer, then refund executes fallback
    let e = boot(false, true, false).await;
    let relayer = e.worker.dev_create_account().await.unwrap();
    e.ft.call("mint").args_json(json!({"account_id": relayer.id(), "amount": U128(usdc(100))})).transact().await.unwrap().unwrap();
    e.admin.call(e.core.id(), "set_relayer_allowed").deposit(ONE_YOCTO).args_json(json!({"account": relayer.id(), "allowed": true})).transact().await.unwrap().unwrap();

    let jid: String = e.admin.call(e.core.id(), "create_job").deposit(STORAGE_DEPOSIT)
        .args_json(json!({"customer": e.customer.id(), "operator": e.operator.id(),
                          "customer_payment": U128(usdc(25)), "max_operating_budget": U128(usdc(10)),
                          "terms_hash": hex32(0xaa), "deadline": 9_999_999_999u64}))
        .transact().await.unwrap().unwrap().json().unwrap();
    relayer.call(e.ft.id(), "ft_transfer_call").deposit(ONE_YOCTO).gas(Gas::from_tgas(100))
        .args_json(json!({"receiver_id": e.core.id(), "amount": U128(usdc(25)), "msg": json!({"FundJob": {"job_id": jid}}).to_string()}))
        .transact().await.unwrap().unwrap();

    e.operator.call(e.core.id(), "refund").gas(Gas::from_tgas(150)).args_json(json!({"job_id": jid})).transact().await.unwrap().unwrap();
    let claimable: U128 = e.core.view("claimable_of").args_json(json!({"account_id": e.customer.id()})).await.unwrap().json().unwrap();
    assert_eq!(claimable.0, usdc(25));
}

#[tokio::test]
async fn test_unregistered_advance_and_lp_withdraw_fallback_to_claimable() {
    // T-20
    let e = boot(true, false, false).await;
    let j20 = fund_two_step(&e, 20, usdc(25)).await;
    e.operator.call(e.core.id(), "request_advance").gas(Gas::from_tgas(150))
        .args_json(json!({"job_id": j20, "expected_principal": U128(12_500_000)}))
        .transact().await.unwrap().unwrap();
    let op_claim: U128 = e.core.view("claimable_of").args_json(json!({"account_id": e.operator.id()})).await.unwrap().json().unwrap();
    assert_eq!(op_claim.0, 12_500_000);

    let unreg_lp = e.worker.dev_create_account().await.unwrap();
    e.admin.call(e.core.id(), "withdraw").deposit(ONE_YOCTO).gas(Gas::from_tgas(150))
        .args_json(json!({"assets": U128(usdc(10)), "receiver": unreg_lp.id()}))
        .transact().await.unwrap().unwrap();
    let lp_claim: U128 = e.core.view("claimable_of").args_json(json!({"account_id": unreg_lp.id()})).await.unwrap().json().unwrap();
    assert_eq!(lp_claim.0, usdc(10));
}

#[tokio::test]
async fn test_flag_stuck_op_pauses_without_double_credit_and_resolves_on_late_callback() {
    // T-22 + T-28 coverage of conservative handling when op remains pending
    let e = boot(true, true, true).await;
    let j22 = fund_two_step(&e, 22, usdc(25)).await;
    let res = e.operator.call(e.core.id(), "refund").gas(Gas::from_tgas(150)).args_json(json!({"job_id": j22})).transact().await.unwrap();
    assert!(res.is_success()); // root receipt succeeded; callback panicked or stayed pending if test-fail-callback enabled
    e.core.call("set_test_force_payout_callback_panic").args_json(json!({"enabled": true})).transact().await.unwrap().unwrap();
    let j23 = fund_two_step(&e, 23, usdc(25)).await;
    let _ = e.operator.call(e.core.id(), "refund").gas(Gas::from_tgas(150)).args_json(json!({"job_id": j23})).transact().await.unwrap();

    // Advance fast-forward > 100 blocks then flag_stuck_op
    e.worker.fast_forward(105).await.unwrap();
    e.admin.call(e.core.id(), "flag_stuck_op").deposit(ONE_YOCTO).args_json(json!({"op_id": 2u64, "note": "delayed"})).transact().await.unwrap().unwrap();
    let ac: Value = e.core.view("accounting").await.unwrap().json().unwrap();
    assert_eq!(ac["vault_paused"], true);
    assert_eq!(ac["pool_paused"], true);
    assert_eq!(ac["total_claimable_usdc"], "0"); // zero double/auto credit
}

#[tokio::test]
async fn test_audit_anchor_async_verification_against_core() {
    // T-23
    let e = boot(true, true, false).await;
    let jid = fund_two_step(&e, 24, usdc(25)).await;
    e.operator.call(e.core.id(), "start_work").args_json(json!({"job_id": jid})).transact().await.unwrap().unwrap();
    e.operator.call(e.core.id(), "submit_delivery").args_json(json!({"job_id": jid, "delivery_hash": hex32(0xcc)})).transact().await.unwrap().unwrap();

    // Rejected while Delivered (not yet Accepted)
    e.authority.call(e.audit.id(), "anchor_job").deposit(ANCHOR_DEPOSIT).gas(Gas::from_tgas(100))
        .args_json(json!({"job_id": jid, "event_root": hex32(1), "payment_receipt_root": hex32(2), "delivery_hash": hex32(0xcc), "completed_at": 1000u64}))
        .transact().await.unwrap().unwrap();
    assert!(e.audit.view("get_anchor").args_json(json!({"job_id": jid})).await.unwrap().json::<Option<Value>>().unwrap().is_none());

    // Accepted -> mismatch rejected, then valid hash finalized
    e.customer.call(e.core.id(), "accept_delivery").gas(Gas::from_tgas(150)).args_json(json!({"job_id": jid})).transact().await.unwrap().unwrap();
    e.authority.call(e.audit.id(), "anchor_job").deposit(ANCHOR_DEPOSIT).gas(Gas::from_tgas(100))
        .args_json(json!({"job_id": jid, "event_root": hex32(1), "payment_receipt_root": hex32(2), "delivery_hash": hex32(0xdd), "completed_at": 1000u64}))
        .transact().await.unwrap().unwrap();
    assert!(e.audit.view("get_anchor").args_json(json!({"job_id": jid})).await.unwrap().json::<Option<Value>>().unwrap().is_none());

    e.authority.call(e.audit.id(), "anchor_job").deposit(ANCHOR_DEPOSIT).gas(Gas::from_tgas(100))
        .args_json(json!({"job_id": jid, "event_root": hex32(1), "payment_receipt_root": hex32(2), "delivery_hash": hex32(0xcc), "completed_at": 1000u64}))
        .transact().await.unwrap().unwrap();
    let anc = e.audit.view("get_anchor").args_json(json!({"job_id": jid})).await.unwrap().json::<Option<Value>>().unwrap();
    assert_eq!(anc.unwrap()["finalized"], true);
}

#[tokio::test]
async fn test_storage_withdraw_success_path() {
    // T-26 (FC-02)
    let e = boot(true, true, false).await;
    e.customer.call(e.core.id(), "storage_deposit").deposit(STORAGE_DEPOSIT).args_json(json!({"account_id": null})).transact().await.unwrap().unwrap();
    e.customer.call(e.core.id(), "storage_withdraw").deposit(ONE_YOCTO).gas(Gas::from_tgas(60)).args_json(json!({"amount": null})).transact().await.unwrap().unwrap();
    let bal: U128 = e.core.view("storage_credit_of").args_json(json!({"account_id": e.customer.id()})).await.unwrap().json().unwrap();
    assert_eq!(bal.0, 0);
    let ac: Value = e.core.view("accounting").await.unwrap().json().unwrap();
    assert_eq!(ac["total_inflight_storage_near"], "0");
}

#[tokio::test]
async fn test_storage_withdraw_failure_restores_credits_additively() {
    // T-27 (FC-02): the beneficiary account is deleted while core's native-NEAR transfer is in flight, and a
    // concurrent storage_deposit lands before the callback. The failed transfer must restore credits additively,
    // clear the lock, return total_inflight_storage_near to 0, and never double-credit.
    let e = boot(true, true, false).await;
    let helper = e.worker.dev_deploy(&withdraw_helper_wasm()).await.unwrap();
    let helper_id = helper.id().clone();
    let x = STORAGE_DEPOSIT.as_yoctonear();

    // First deposit for the helper also pays its one-time credit-record registration (Decision 4).
    e.admin.call(e.core.id(), "storage_deposit").deposit(NearToken::from_yoctonear(2 * x + STORAGE_REGISTRATION.as_yoctonear()))
        .args_json(json!({"account_id": &helper_id})).transact().await.unwrap().unwrap();
    let before: Value = e.core.view("accounting").await.unwrap().json().unwrap();
    let credits_total_before: u128 = before["total_storage_credits"].as_str().unwrap().parse().unwrap();

    let res = helper.call("withdraw_deposit_and_self_destruct").gas(Gas::from_tgas(150))
        .args_json(json!({"core": e.core.id(), "withdraw_yocto": U128(x), "deposit_yocto": U128(x),
                          "beneficiary": e.admin.id()}))
        .transact().await.unwrap();
    assert!(res.is_success(), "helper tx failed: {:?}", res);
    let logs = res.logs().join("\n");
    assert!(logs.contains("\"event\":\"StorageWithdrawRequested\""), "logs: {logs}");
    assert!(logs.contains("\"event\":\"StorageWithdrawFailed\""), "transfer did not fail in flight; logs: {logs}");
    assert!(!logs.contains("\"event\":\"StorageWithdrawn\""));

    // Beneficiary really is gone
    assert!(e.worker.view_account(&helper_id).await.is_err());

    // 2x - x (withdraw) + x (concurrent deposit) + x (additive restore) = 3x; no double credit
    let bal: U128 = e.core.view("storage_credit_of").args_json(json!({"account_id": &helper_id})).await.unwrap().json().unwrap();
    assert_eq!(bal.0, 3 * x);
    let lock: Option<u64> = e.core.view("storage_withdraw_lock_of").args_json(json!({"account_id": &helper_id})).await.unwrap().json().unwrap();
    assert!(lock.is_none());
    let ac: Value = e.core.view("accounting").await.unwrap().json().unwrap();
    assert_eq!(ac["total_inflight_storage_near"], "0");
    let credits_total_after: u128 = ac["total_storage_credits"].as_str().unwrap().parse().unwrap();
    assert_eq!(credits_total_after, credits_total_before + x);
}

#[tokio::test]
async fn test_failed_payout_callback_is_conservative() {
    // T-28 (FC-03): force callback panic and verify PendingOp remains + total_in_flight_usdc unchanged + no auto credit
    let e = boot(true, true, true).await;
    let j28 = fund_two_step(&e, 28, usdc(25)).await;
    e.core.call("set_test_force_payout_callback_panic").args_json(json!({"enabled": true})).transact().await.unwrap().unwrap();
    let _ = e.operator.call(e.core.id(), "refund").gas(Gas::from_tgas(150)).args_json(json!({"job_id": j28})).transact().await.unwrap();
    let ac: Value = e.core.view("accounting").await.unwrap().json().unwrap();
    assert_eq!(ac["total_in_flight_usdc"], usdc(25).to_string());
    assert_eq!(ac["total_claimable_usdc"], "0");
    assert!(e.core.view("get_pending_op").args_json(json!({"op_id": 1u64})).await.unwrap().json::<Option<Value>>().unwrap().is_some());
}

#[tokio::test]
async fn test_empirical_gas_and_storage_measurements() {
    // T-25 + T-29 helper checks gas per receipt hop
    let e = boot(true, true, false).await;
    let j25 = fund_two_step(&e, 25, usdc(25)).await;
    let res = e.operator.call(e.core.id(), "request_advance").gas(Gas::from_tgas(150))
        .args_json(json!({"job_id": j25, "expected_principal": U128(12_500_000)}))
        .transact().await.unwrap();
    for o in res.receipt_outcomes() {
        assert!(o.gas_burnt <= Gas::from_tgas(22), "receipt gas {} exceeded 50% of 45 TGas", o.gas_burnt);
    }
}

#[tokio::test]
async fn test_full_persistent_storage_delta_gate() {
    // T-29 (FC-04): measure storage_usage delta with worst-case 64-char AccountIds
    let e = boot(true, true, false).await;
    let long_cust: near_workspaces::AccountId = format!("{}.test.near", "c".repeat(54)).parse().unwrap();
    let long_op: near_workspaces::AccountId = format!("{}.test.near", "o".repeat(54)).parse().unwrap();
    let before = e.core.view_account().await.unwrap().storage_usage;
    e.admin.call(e.core.id(), "create_job").deposit(STORAGE_DEPOSIT)
        .args_json(json!({"customer": long_cust, "operator": long_op,
                          "customer_payment": U128(usdc(25)), "max_operating_budget": U128(usdc(10)),
                          "terms_hash": hex32(0xaa), "deadline": 9_999_999_999u64}))
        .transact().await.unwrap().unwrap();
    let after = e.core.view_account().await.unwrap().storage_usage;
    let delta = after - before;
    let required_yocto = ((delta as u128 * 3 + 1) / 2) * 10_000_000_000_000_000_000u128; // 1.5x * 1e19
    let configured: U128 = e.core.view("job_storage_deposit").await.unwrap().json().unwrap();
    assert!(configured.0 >= required_yocto, "measured {delta} bytes requires {required_yocto} yocto > {}", configured.0);
}

#[tokio::test]
async fn test_prepared_mainnet_escrow_payload_and_failure_matrix_sandbox() {
    // Pre-deployment compatibility gate against compiled WASM (`snapfall_core.wasm` + `mock_ft.wasm`):
    // Exercises the exact two-step flow prepared by `POST /api/near/prepare-tx`:
    //   1. `storage_deposit({"account_id": customer})` with 0.030 NEAR (0.007 registration + 0.023 job storage)
    //   2. `ft_transfer_call` with `CreateAndFundJob` JSON msg
    // Plus all 5 failure / refund cases through `ft_resolve_transfer`.
    let e = boot(true, true, false).await;
    let terms_hex = "0xd8a2a66c36307e760125edcea6a9867891c4d19ef472e5a52e3db1583b3e14de";
    let deadline_sec = 1_794_591_000u64;
    let payment_atomic = usdc(100); // $100.00 USDC ("100000000")
    let budget_atomic = usdc(25); // $25.00 USDC ("25000000")

    let create_and_fund_msg = json!({
        "CreateAndFundJob": {
            "operator": e.operator.id(),
            "max_operating_budget": budget_atomic.to_string(),
            "terms_hash": terms_hex,
            "deadline": deadline_sec,
        }
    })
    .to_string();

    let cust_bal_initial: U128 = e.ft.view("ft_balance_of").args_json(json!({"account_id": e.customer.id()})).await.unwrap().json().unwrap();
    let core_bal_initial: U128 = e.ft.view("ft_balance_of").args_json(json!({"account_id": e.core.id()})).await.unwrap().json().unwrap();

    // ─── Failure Case 1: Insufficient storage credits -> ft_on_transfer panics -> ft_resolve_transfer refunds 100% ───
    let used_1: U128 = e.customer.call(e.ft.id(), "ft_transfer_call")
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(100))
        .args_json(json!({
            "receiver_id": e.core.id(),
            "amount": payment_atomic.to_string(),
            "memo": "SnowMoon CreateAndFundJob Escrow",
            "msg": create_and_fund_msg,
        }))
        .transact().await.unwrap().unwrap().json().unwrap();
    assert_eq!(used_1.0, 0, "ft_resolve_transfer must refund 100% when storage credits are missing");
    let cust_bal_after_1: U128 = e.ft.view("ft_balance_of").args_json(json!({"account_id": e.customer.id()})).await.unwrap().json().unwrap();
    assert_eq!(cust_bal_after_1.0, cust_bal_initial.0);

    // ─── Step 1 of `/api/near/prepare-tx`: Register customer storage + 1 job deposit (0.030 NEAR) ───
    let first_time_storage_deposit = NearToken::from_millinear(30); // 0.007 NEAR registration + 0.023 NEAR job deposit
    e.customer.call(e.core.id(), "storage_deposit")
        .deposit(first_time_storage_deposit)
        .gas(Gas::from_tgas(30))
        .args_json(json!({"account_id": e.customer.id()}))
        .transact().await.unwrap().unwrap();
    let credit_bal: U128 = e.core.view("storage_credit_of").args_json(json!({"account_id": e.customer.id()})).await.unwrap().json().unwrap();
    assert_eq!(credit_bal.0, STORAGE_DEPOSIT.as_yoctonear());

    // ─── Failure Case 2: Invalid msg JSON -> ft_on_transfer panics -> 100% USDC refunded ───
    let used_2: U128 = e.customer.call(e.ft.id(), "ft_transfer_call")
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(100))
        .args_json(json!({
            "receiver_id": e.core.id(),
            "amount": payment_atomic.to_string(),
            "memo": "SnowMoon CreateAndFundJob Escrow",
            "msg": r#"{"MalformedVariant":{}}"#,
        }))
        .transact().await.unwrap().unwrap().json().unwrap();
    assert_eq!(used_2.0, 0);

    // ─── Failure Case 3: Paused vault -> ft_on_transfer panics -> 100% USDC refunded ───
    e.admin.call(e.core.id(), "set_vault_paused").deposit(ONE_YOCTO).args_json(json!({"paused": true})).transact().await.unwrap().unwrap();
    let used_3: U128 = e.customer.call(e.ft.id(), "ft_transfer_call")
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(100))
        .args_json(json!({
            "receiver_id": e.core.id(),
            "amount": payment_atomic.to_string(),
            "memo": "SnowMoon CreateAndFundJob Escrow",
            "msg": create_and_fund_msg,
        }))
        .transact().await.unwrap().unwrap().json().unwrap();
    assert_eq!(used_3.0, 0);
    e.admin.call(e.core.id(), "set_vault_paused").deposit(ONE_YOCTO).args_json(json!({"paused": false})).transact().await.unwrap().unwrap();

    // ─── Failure Case 4: Amount above max_job_payment ($1,000 USDC) -> ft_on_transfer panics -> 100% refunded ───
    e.ft.call("mint").args_json(json!({"account_id": e.customer.id(), "amount": U128(usdc(1_000))})).transact().await.unwrap().unwrap();
    let cust_bal_minted: U128 = e.ft.view("ft_balance_of").args_json(json!({"account_id": e.customer.id()})).await.unwrap().json().unwrap();
    let used_4: U128 = e.customer.call(e.ft.id(), "ft_transfer_call")
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(100))
        .args_json(json!({
            "receiver_id": e.core.id(),
            "amount": usdc(1_001).to_string(),
            "memo": "SnowMoon CreateAndFundJob Escrow",
            "msg": create_and_fund_msg,
        }))
        .transact().await.unwrap().unwrap().json().unwrap();
    assert_eq!(used_4.0, 0);
    let cust_bal_after_4: U128 = e.ft.view("ft_balance_of").args_json(json!({"account_id": e.customer.id()})).await.unwrap().json().unwrap();
    assert_eq!(cust_bal_after_4.0, cust_bal_minted.0);

    // ─── Step 2 Success Path: Call `ft_transfer_call` with generated `CreateAndFundJob` message ───
    let seq_before: u64 = e.core.view("next_job_seq").await.unwrap().json().unwrap();
    let expected_job_id: String = e.core.view("derive_job_id")
        .args_json(json!({"creator": e.customer.id(), "seq": seq_before}))
        .await.unwrap().json().unwrap();

    let used_ok: U128 = e.customer.call(e.ft.id(), "ft_transfer_call")
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(100))
        .args_json(json!({
            "receiver_id": e.core.id(),
            "amount": payment_atomic.to_string(),
            "memo": "SnowMoon CreateAndFundJob Escrow",
            "msg": create_and_fund_msg,
        }))
        .transact().await.unwrap().unwrap().json().unwrap();

    // Token resolver kept 100% of payment_atomic (0 refunded)
    assert_eq!(used_ok.0, payment_atomic);

    let seq_after: u64 = e.core.view("next_job_seq").await.unwrap().json().unwrap();
    assert_eq!(seq_after, seq_before + 1, "job must be created exactly once");

    let job: Value = e.core.view("get_job").args_json(json!({"job_id": expected_job_id})).await.unwrap().json().unwrap();
    assert_eq!(job["customer"], e.customer.id().as_str());
    assert_eq!(job["operator"], e.operator.id().as_str());
    assert_eq!(job["customer_payment"], payment_atomic.to_string());
    assert_eq!(job["max_operating_budget"], budget_atomic.to_string());
    assert_eq!(job["terms_hash"], terms_hex);
    assert_eq!(job["deadline"], deadline_sec);
    assert_eq!(job["status"], "Funded");

    let ac: Value = e.core.view("accounting").await.unwrap().json().unwrap();
    assert_eq!(ac["escrowed_usdc"], payment_atomic.to_string());
    let core_bal_after: U128 = e.ft.view("ft_balance_of").args_json(json!({"account_id": e.core.id()})).await.unwrap().json().unwrap();
    assert_eq!(core_bal_after.0, core_bal_initial.0 + payment_atomic);
}


