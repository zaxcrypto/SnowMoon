use std::io::{self, Read, Write};

const SCHEMA_VERSION: &str = "snowmoon-tee-worker/v1";

#[derive(Debug, PartialEq, Eq)]
struct WorkerInput {
    job_id: String,
    worker_id: String,
    prompt: String,
    evidence_hash: String,
}

/// Pure-Rust FIPS 180-4 SHA-256 (zero external crate dependencies for minimal TCB in wasm32-wasip2).
fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut msg = data.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[4 * i],
                chunk[4 * i + 1],
                chunk[4 * i + 2],
                chunk[4 * i + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[4 * i..4 * (i + 1)].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn to_hex_0x(bytes: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(66);
    s.push_str("0x");
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

fn extract_json_string(raw: &str, key: &str) -> Result<String, String> {
    let pattern = format!("\"{key}\"");
    let start = raw
        .find(&pattern)
        .ok_or_else(|| format!("ERR_MISSING_FIELD: {key}"))?;
    let after_key = &raw[start + pattern.len()..];
    let colon = after_key
        .find(':')
        .ok_or_else(|| format!("ERR_INVALID_JSON: missing ':' after {key}"))?;
    let rest = after_key[colon + 1..].trim_start();
    if !rest.starts_with('"') {
        return Err(format!("ERR_INVALID_TYPE: {key} must be a JSON string"));
    }
    let mut chars = rest[1..].chars();
    let mut out = String::new();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Ok(out),
            '\\' => {
                let esc = chars
                    .next()
                    .ok_or_else(|| format!("ERR_INVALID_JSON: trailing escape in {key}"))?;
                match esc {
                    '"' => out.push('"'),
                    '\\' => out.push('\\'),
                    '/' => out.push('/'),
                    'n' => out.push('\n'),
                    'r' => out.push('\r'),
                    't' => out.push('\t'),
                    other => out.push(other),
                }
            }
            other => out.push(other),
        }
    }
    Err(format!("ERR_INVALID_JSON: unterminated string for {key}"))
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn validate_hex32_nonzero(s: &str) -> Result<String, String> {
    let lower = s.trim().to_ascii_lowercase();
    let hex = lower
        .strip_prefix("0x")
        .ok_or_else(|| "ERR_HEX32_PREFIX: evidenceHash must start with 0x".to_string())?;
    if hex.len() != 64 || !hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err("ERR_HEX32_FORMAT: evidenceHash must be 64 hex chars".to_string());
    }
    if hex.bytes().all(|b| b == b'0') {
        return Err("ERR_ZERO_HASH: evidenceHash cannot be all-zero".to_string());
    }
    Ok(format!("0x{hex}"))
}

fn process_request(raw_input: &str) -> Result<String, String> {
    let job_id = extract_json_string(raw_input, "jobId")?;
    let worker_id = extract_json_string(raw_input, "workerId")?;
    let prompt = extract_json_string(raw_input, "prompt")?;
    let raw_evidence = extract_json_string(raw_input, "evidenceHash")?;

    if job_id.trim().is_empty() {
        return Err("ERR_EMPTY_JOB_ID: jobId is required".to_string());
    }
    if worker_id.trim().is_empty() {
        return Err("ERR_EMPTY_WORKER_ID: workerId is required".to_string());
    }
    if prompt.trim().is_empty() {
        return Err("ERR_EMPTY_PROMPT: prompt is required".to_string());
    }
    let evidence_hash = validate_hex32_nonzero(&raw_evidence)?;

    let input_commitment_preimage = format!("{job_id}|{worker_id}|{prompt}|{evidence_hash}");
    let input_commitment = to_hex_0x(&sha256(input_commitment_preimage.as_bytes()));

    let tee_verdict = "VERIFIED_IN_TEE";
    let verdict_preimage =
        format!("{SCHEMA_VERSION}|{job_id}|{worker_id}|{evidence_hash}|{input_commitment}|{tee_verdict}");
    let verdict_digest = to_hex_0x(&sha256(verdict_preimage.as_bytes()));

    Ok(format!(
        "{{\"ok\":true,\"schemaVersion\":{},\"jobId\":{},\"workerId\":{},\"evidenceHash\":{},\"inputCommitment\":{},\"teeVerdict\":{},\"verdictDigest\":{}}}",
        json_escape(SCHEMA_VERSION),
        json_escape(&job_id),
        json_escape(&worker_id),
        json_escape(&evidence_hash),
        json_escape(&input_commitment),
        json_escape(tee_verdict),
        json_escape(&verdict_digest),
    ))
}

fn main() {
    let mut input = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input) {
        let _ = writeln!(io::stderr(), "{{\"ok\":false,\"error\":\"ERR_STDIN_READ: {e}\"}}");
        std::process::exit(1);
    }
    match process_request(&input) {
        Ok(out) => {
            if let Err(e) = writeln!(io::stdout(), "{out}") {
                let _ = writeln!(io::stderr(), "{{\"ok\":false,\"error\":\"ERR_STDOUT_WRITE: {e}\"}}");
                std::process::exit(1);
            }
        }
        Err(err) => {
            let _ = writeln!(io::stderr(), "{{\"ok\":false,\"error\":{}}}", json_escape(&err));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_nist_abc() {
        let digest = to_hex_0x(&sha256(b"abc"));
        assert_eq!(
            digest,
            "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn process_request_binds_job_and_evidence() {
        let req = r#"{"jobId":"job-1","workerId":"w-1","prompt":"audit core","evidenceHash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#;
        let out = process_request(req).expect("valid request");
        assert!(out.contains("\"ok\":true"));
        assert!(out.contains("\"jobId\":\"job-1\""));
        assert!(out.contains("\"teeVerdict\":\"VERIFIED_IN_TEE\""));
    }

    #[test]
    fn process_request_rejects_zero_evidence_hash() {
        let req = r#"{"jobId":"job-1","workerId":"w-1","prompt":"audit","evidenceHash":"0x0000000000000000000000000000000000000000000000000000000000000000"}"#;
        let err = process_request(req).expect_err("zero hash must fail");
        assert!(err.contains("ERR_ZERO_HASH"));
    }
}

