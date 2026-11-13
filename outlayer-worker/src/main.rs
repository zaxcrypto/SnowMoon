use std::io::{self, Read};

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

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    let bit_len = (data.len() as u64) * 8;
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
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
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
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn sha256_hex_prefixed(data: &[u8]) -> String {
    let digest = sha256(data);
    let mut out = String::with_capacity(66);
    out.push_str("0x");
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for b in digest {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn normalize_hex32(s: &str) -> Result<String, String> {
    let trimmed = s.trim().to_ascii_lowercase();
    let hex_part = trimmed.strip_prefix("0x").unwrap_or(&trimmed);
    if hex_part.len() != 64 || !hex_part.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("evidenceHash must be a 32-byte hex string (0x + 64 hex chars)".to_string());
    }
    Ok(format!("0x{}", hex_part))
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                use std::fmt::Write;
                let _ = write!(&mut out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn extract_json_string_field(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\"", key);
    let bytes = json.as_bytes();
    let mut idx = 0;
    while let Some(pos) = json[idx..].find(&needle) {
        let abs = idx + pos + needle.len();
        let rest = json[abs..].trim_start();
        if let Some(after_colon) = rest.strip_prefix(':') {
            let val_str = after_colon.trim_start();
            if val_str.starts_with('"') {
                let mut out = String::new();
                let mut chars = val_str[1..].chars();
                while let Some(c) = chars.next() {
                    if c == '"' {
                        return Some(out);
                    }
                    if c == '\\' {
                        match chars.next() {
                            Some('"') => out.push('"'),
                            Some('\\') => out.push('\\'),
                            Some('/') => out.push('/'),
                            Some('n') => out.push('\n'),
                            Some('r') => out.push('\r'),
                            Some('t') => out.push('\t'),
                            Some('b') => out.push('\u{0008}'),
                            Some('f') => out.push('\u{000c}'),
                            Some('u') => {
                                let hex: String = chars.by_ref().take(4).collect();
                                if let Ok(code) = u32::from_str_radix(&hex, 16) {
                                    if let Some(uc) = char::from_u32(code) {
                                        out.push(uc);
                                    }
                                }
                            }
                            Some(other) => out.push(other),
                            None => return None,
                        }
                    } else {
                        out.push(c);
                    }
                }
            }
            return None;
        }
        idx = abs.min(bytes.len());
    }
    None
}

fn process_input(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
        return Err("Input must be a JSON object".to_string());
    }

    let job_id = extract_json_string_field(trimmed, "jobId")
        .unwrap_or_default()
        .trim()
        .to_string();
    let worker_id = extract_json_string_field(trimmed, "workerId")
        .unwrap_or_default()
        .trim()
        .to_string();
    let prompt = extract_json_string_field(trimmed, "prompt")
        .unwrap_or_default()
        .trim()
        .to_string();
    let evidence_raw = extract_json_string_field(trimmed, "evidenceHash").unwrap_or_default();

    if job_id.is_empty() {
        return Err("jobId must not be empty".to_string());
    }
    if worker_id.is_empty() {
        return Err("workerId must not be empty".to_string());
    }
    if prompt.is_empty() {
        return Err("prompt must not be empty".to_string());
    }
    let evidence_hash = normalize_hex32(&evidence_raw)?;

    let prompt_sha256 = sha256_hex_prefixed(prompt.as_bytes());
    let binding_preimage = format!(
        "snowmoon-tee-v1|{}|{}|{}|{}",
        job_id, worker_id, evidence_hash, prompt_sha256
    );
    let tee_binding_hash = sha256_hex_prefixed(binding_preimage.as_bytes());

    let execution_type =
        std::env::var("OUTLAYER_EXECUTION_TYPE").unwrap_or_else(|_| "HTTPS".to_string());
    let call_id = std::env::var("OUTLAYER_CALL_ID").unwrap_or_default();
    let project_id = std::env::var("OUTLAYER_PROJECT_ID").unwrap_or_default();
    let near_sender_id = std::env::var("NEAR_SENDER_ID").unwrap_or_default();

    Ok(format!(
        "{{\"ok\":true,\"jobId\":{},\"workerId\":{},\"evidenceHash\":{},\"promptSha256\":{},\"teeBindingHash\":{},\"executionType\":{},\"callId\":{},\"projectId\":{},\"nearSenderId\":{}}}",
        json_escape(&job_id),
        json_escape(&worker_id),
        json_escape(&evidence_hash),
        json_escape(&prompt_sha256),
        json_escape(&tee_binding_hash),
        json_escape(&execution_type),
        json_escape(&call_id),
        json_escape(&project_id),
        json_escape(&near_sender_id)
    ))
}

fn main() {
    let mut buf = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut buf) {
        eprintln!("ERR_STDIN_READ: {}", e);
        std::process::exit(1);
    }

    match process_input(&buf) {
        Ok(json) => println!("{}", json),
        Err(err) => {
            eprintln!("ERR_SNOWMOON_TEE_WORKER: {}", err);
            std::process::exit(1);
        }
    }
}
