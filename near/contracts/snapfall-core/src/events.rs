//! NEP-297 events (spec §10). standard = "snapfall", version = "1.0.0".
//! All amounts are decimal strings; keys are camelCase. The 8 H1 events are frozen.
use crate::types::Hex32;
use near_sdk::{env, AccountId};

pub const STANDARD: &str = "snapfall";
pub const VERSION: &str = "1.0.0";

fn fmt_u128(mut v: u128, buf: &mut [u8; 40]) -> &str {
    if v == 0 {
        return "0";
    }
    let mut i = 40;
    while v > 0 {
        i -= 1;
        buf[i] = b'0' + (v % 10) as u8;
        v /= 10;
    }
    // SAFETY: digits '0'..='9' are valid ASCII/UTF-8.
    unsafe { core::str::from_utf8_unchecked(&buf[i..]) }
}

/// Lightweight NEP-297 JSON object builder avoiding `serde_json::Value` / `BTreeMap` bloat.
pub struct JsonObj {
    buf: String,
    first: bool,
}

impl JsonObj {
    pub fn new() -> Self {
        Self { buf: String::with_capacity(128), first: true }
    }

    fn sep(&mut self, key: &str) {
        if !self.first {
            self.buf.push(',');
        }
        self.first = false;
        self.buf.push('"');
        self.buf.push_str(key);
        self.buf.push_str("\":");
    }

    fn push_escaped(&mut self, val: &str) {
        self.buf.push('"');
        for ch in val.chars() {
            match ch {
                '"' => self.buf.push_str("\\\""),
                '\\' => self.buf.push_str("\\\\"),
                '\n' => self.buf.push_str("\\n"),
                '\r' => self.buf.push_str("\\r"),
                '\t' => self.buf.push_str("\\t"),
                _ => self.buf.push(ch),
            }
        }
        self.buf.push('"');
    }

    pub fn str(mut self, key: &str, val: &str) -> Self {
        self.sep(key);
        self.push_escaped(val);
        self
    }

    pub fn acc(self, key: &str, val: &AccountId) -> Self {
        self.str(key, val.as_str())
    }

    pub fn hex(self, key: &str, val: &Hex32) -> Self {
        self.str(key, &val.to_hex())
    }

    pub fn u128_str(mut self, key: &str, val: u128) -> Self {
        self.sep(key);
        let mut b = [0u8; 40];
        let s = fmt_u128(val, &mut b);
        self.buf.push('"');
        self.buf.push_str(s);
        self.buf.push('"');
        self
    }

    pub fn u64_num(mut self, key: &str, val: u64) -> Self {
        self.sep(key);
        let mut b = [0u8; 40];
        self.buf.push_str(fmt_u128(val as u128, &mut b));
        self
    }

    pub fn bool(mut self, key: &str, val: bool) -> Self {
        self.sep(key);
        self.buf.push_str(if val { "true" } else { "false" });
        self
    }
}

pub fn emit(event: &str, data: JsonObj) {
    let mut out = String::with_capacity(64 + event.len() + data.buf.len());
    out.push_str("EVENT_JSON:{\"standard\":\"");
    out.push_str(STANDARD);
    out.push_str("\",\"version\":\"");
    out.push_str(VERSION);
    out.push_str("\",\"event\":\"");
    out.push_str(event);
    out.push_str("\",\"data\":[{");
    out.push_str(&data.buf);
    out.push_str("}]}");
    env::log_str(&out);
}

// ───── H1 frozen events ─────
pub fn job_funded(job_id: &Hex32, amount: u128) {
    emit("JobFunded", JsonObj::new().hex("jobId", job_id).u128_str("amountAtomic", amount));
}
pub fn advance_issued(job_id: &Hex32, org: &AccountId, principal: u128, fee: u128, rate_bps: u16, via: &str) {
    emit(
        "AdvanceIssued",
        JsonObj::new()
            .hex("jobId", job_id)
            .acc("org", org)
            .u128_str("principalAtomic", principal)
            .u128_str("feeAtomic", fee)
            .u128_str("rateBps", rate_bps as u128)
            .str("settledVia", via),
    );
}
pub fn expense_recorded(job_id: &Hex32, amount: u128, receipt_hash: &Hex32) {
    emit(
        "ExpenseRecorded",
        JsonObj::new().hex("jobId", job_id).u128_str("amountAtomic", amount).hex("receiptHash", receipt_hash),
    );
}
pub fn delivery_submitted(job_id: &Hex32, delivery_hash: &Hex32) {
    emit("DeliverySubmitted", JsonObj::new().hex("jobId", job_id).hex("deliveryHash", delivery_hash));
}
pub fn advance_repaid(job_id: &Hex32, principal: u128, fee: u128, to_reserve: u128) {
    emit(
        "AdvanceRepaid",
        JsonObj::new()
            .hex("jobId", job_id)
            .u128_str("principalAtomic", principal)
            .u128_str("feeAtomic", fee)
            .u128_str("toReserveAtomic", to_reserve),
    );
}
pub fn job_settled(job_id: &Hex32, advance_repaid: u128, operator_net: u128, via: &str) {
    emit(
        "JobSettled",
        JsonObj::new()
            .hex("jobId", job_id)
            .u128_str("advanceRepaidAtomic", advance_repaid)
            .u128_str("operatorNetAtomic", operator_net)
            .str("settledVia", via),
    );
}
pub fn advance_written_off(job_id: &Hex32, bond: u128, reserve_used: u128, socialized: u128) {
    emit(
        "AdvanceWrittenOff",
        JsonObj::new()
            .hex("jobId", job_id)
            .u128_str("bondSlashedAtomic", bond)
            .u128_str("reserveUsedAtomic", reserve_used)
            .u128_str("socializedAtomic", socialized),
    );
}
pub fn rate_changed(org: &AccountId, rate_bps: u16) {
    emit("RateChanged", JsonObj::new().acc("org", org).u128_str("rateBps", rate_bps as u128));
}

// ───── Additional events (§10.2) ─────
pub fn simple(event: &str, data: JsonObj) {
    emit(event, data);
}

