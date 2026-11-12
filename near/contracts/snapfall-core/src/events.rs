//! NEP-297 events (spec §10). standard = "snapfall", version = "1.0.0".
//! All amounts are decimal strings; keys are camelCase. The 8 H1 events are frozen.
use crate::types::Hex32;
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, AccountId};

pub const STANDARD: &str = "snapfall";
pub const VERSION: &str = "1.0.0";

pub fn emit(event: &str, data: Value) {
    let v = json!({
        "standard": STANDARD,
        "version": VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", v));
}

fn s(x: u128) -> String {
    x.to_string()
}

// ───── H1 frozen events ─────
pub fn job_funded(job_id: &Hex32, amount: u128) {
    emit("JobFunded", json!({"jobId": job_id.to_hex(), "amountAtomic": s(amount)}));
}
pub fn advance_issued(job_id: &Hex32, org: &AccountId, principal: u128, fee: u128, rate_bps: u16, via: &str) {
    emit(
        "AdvanceIssued",
        json!({"jobId": job_id.to_hex(), "org": org, "principalAtomic": s(principal),
               "feeAtomic": s(fee), "rateBps": rate_bps.to_string(), "settledVia": via}),
    );
}
pub fn expense_recorded(job_id: &Hex32, amount: u128, receipt_hash: &Hex32) {
    emit(
        "ExpenseRecorded",
        json!({"jobId": job_id.to_hex(), "amountAtomic": s(amount), "receiptHash": receipt_hash.to_hex()}),
    );
}
pub fn delivery_submitted(job_id: &Hex32, delivery_hash: &Hex32) {
    emit("DeliverySubmitted", json!({"jobId": job_id.to_hex(), "deliveryHash": delivery_hash.to_hex()}));
}
pub fn advance_repaid(job_id: &Hex32, principal: u128, fee: u128, to_reserve: u128) {
    emit(
        "AdvanceRepaid",
        json!({"jobId": job_id.to_hex(), "principalAtomic": s(principal), "feeAtomic": s(fee),
               "toReserveAtomic": s(to_reserve)}),
    );
}
pub fn job_settled(job_id: &Hex32, advance_repaid: u128, operator_net: u128, via: &str) {
    emit(
        "JobSettled",
        json!({"jobId": job_id.to_hex(), "advanceRepaidAtomic": s(advance_repaid),
               "operatorNetAtomic": s(operator_net), "settledVia": via}),
    );
}
pub fn advance_written_off(job_id: &Hex32, bond: u128, reserve_used: u128, socialized: u128) {
    emit(
        "AdvanceWrittenOff",
        json!({"jobId": job_id.to_hex(), "bondSlashedAtomic": s(bond), "reserveUsedAtomic": s(reserve_used),
               "socializedAtomic": s(socialized)}),
    );
}
pub fn rate_changed(org: &AccountId, rate_bps: u16) {
    emit("RateChanged", json!({"org": org, "rateBps": rate_bps.to_string()}));
}

// ───── Additional events (§10.2) ─────
pub fn simple(event: &str, data: Value) {
    emit(event, data);
}

