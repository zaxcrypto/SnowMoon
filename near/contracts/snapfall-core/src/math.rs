//! Pure accounting math (spec §8.1, FloatPool.sol rate curve). No state access.
//! All intermediate products are computed with checked u128 arithmetic widened via
//! a 256-bit mul-div so `assets * (S + 1)` cannot overflow.

pub const VIRTUAL_ASSETS: u128 = 1;
pub const VIRTUAL_SHARES: u128 = 1;
pub const MIN_DEPOSIT_USDC: u128 = 1_000_000;

pub const BASE_BPS: u128 = 5000;
pub const GROWTH_BPS: u128 = 500;
pub const PENALTY_BPS: u128 = 1500;
pub const FLOOR_BPS: u128 = 3000;
pub const CAP_BPS: u128 = 8500;
pub const FEE_BPS: u128 = 200;
pub const RESERVE_CUT_BPS: u128 = 2000;
pub const ORG_EXPOSURE_CAP_BPS: u128 = 1000;
pub const UTILIZATION_CAP_BPS: u128 = 8000;
pub const BPS: u128 = 10_000;
pub const WAD: u128 = 1_000_000_000_000_000_000;

/// 256-bit product of two u128 as (hi, lo).
fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let mask = u64::MAX as u128;
    let (a0, a1) = (a & mask, a >> 64);
    let (b0, b1) = (b & mask, b >> 64);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & mask) + (p10 & mask);
    let lo = (p00 & mask) | ((mid & mask) << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

/// floor(a * b / d). Panics on d == 0 or if the quotient does not fit u128.
pub fn mul_div_floor(a: u128, b: u128, d: u128) -> u128 {
    assert!(d != 0, "ERR_DIV_ZERO");
    let (hi, lo) = mul_wide(a, b);
    if hi == 0 {
        return lo / d;
    }
    assert!(hi < d, "ERR_MULDIV_OVERFLOW");
    // Long division of the 256-bit (hi, lo) by d, bit by bit (only reached for huge values).
    let mut rem = hi;
    let mut q: u128 = 0;
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        q <<= 1;
        if carry == 1 || rem >= d {
            rem = rem.wrapping_sub(d);
            q |= 1;
        }
    }
    q
}

/// ceil(a * b / d).
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> u128 {
    let f = mul_div_floor(a, b, d);
    let (hi, lo) = mul_wide(f, d);
    let (phi, plo) = mul_wide(a, b);
    if hi == phi && lo == plo {
        f
    } else {
        f.checked_add(1).expect("ERR_OVERFLOW")
    }
}

/// shares = floor(assets * (S + 1) / (A + 1))
pub fn preview_deposit(assets: u128, total_assets: u128, total_shares: u128) -> u128 {
    mul_div_floor(assets, total_shares + VIRTUAL_SHARES, total_assets + VIRTUAL_ASSETS)
}

/// shares = ceil(assets * (S + 1) / (A + 1))
pub fn preview_withdraw(assets: u128, total_assets: u128, total_shares: u128) -> u128 {
    mul_div_ceil(assets, total_shares + VIRTUAL_SHARES, total_assets + VIRTUAL_ASSETS)
}

/// assets = floor(shares * (A + 1) / (S + 1))
pub fn preview_redeem(shares: u128, total_assets: u128, total_shares: u128) -> u128 {
    mul_div_floor(shares, total_assets + VIRTUAL_ASSETS, total_shares + VIRTUAL_SHARES)
}

/// floor((A + 1) * 1e18 / (S + 1))
pub fn share_price_wad(total_assets: u128, total_shares: u128) -> u128 {
    mul_div_floor(total_assets + VIRTUAL_ASSETS, WAD, total_shares + VIRTUAL_SHARES)
}

/// clamp(5000 + 500*accepted - 1500*written_off, 3000, 8500), saturating at floor (FloatPool.sol:301).
pub fn advance_rate(accepted: u32, written_off: u32) -> u16 {
    let base = BASE_BPS + GROWTH_BPS * accepted as u128;
    let penalty = PENALTY_BPS * written_off as u128;
    let mut r = if penalty >= base { FLOOR_BPS } else { base - penalty };
    if r < FLOOR_BPS {
        r = FLOOR_BPS;
    }
    if r > CAP_BPS {
        r = CAP_BPS;
    }
    r as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn muldiv_basic_and_wide() {
        assert_eq!(mul_div_floor(10, 10, 3), 33);
        assert_eq!(mul_div_ceil(10, 10, 3), 34);
        assert_eq!(mul_div_ceil(9, 10, 3), 30);
        let big = u128::MAX / 2;
        assert_eq!(mul_div_floor(big, 4, 4), big);
        assert_eq!(mul_div_floor(u128::MAX, u128::MAX, u128::MAX), u128::MAX);
    }
}

