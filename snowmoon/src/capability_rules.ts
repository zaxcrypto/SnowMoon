/**
 * Capability-scoped system rules for SnowMoon Autonomous AI Workers.
 * Rules are strictly scoped to the selected capability (e.g., "security-audit")
 * so each capability can evolve its own verification checklist, error recovery,
 * and output contract independently.
 */

export function normalizeCapability(capability?: string): string {
  const raw = String(capability || "").trim().toLowerCase();
  if (raw === "audit" || raw === "security-audit" || raw === "security_audit") {
    return "security-audit";
  }
  return raw || "analysis";
}

const SECURITY_AUDIT_RULES = `
CAPABILITY PROFILE: SECURITY AUDIT (MANDATORY PROTOCOL)
Apply these rules strictly because this job's capability is "security-audit":

1. INPUT & TOOL EXECUTION WORKFLOW (ANTI-BURN — NO DUPLICATE CALLS):
   - If an "--- ATTACHED CODE FILE: <filename> ---" block is present in the task:
     Audit every relevant line of the attached code directly first, citing exact filename and line numbers.
   - If a GitHub repository URL is present:
     a) Call \`github_repo_tree\` ONCE to map the repository.
     b) Select ONLY the 3-4 highest-risk source files (e.g., smart contracts \`.rs\`/\`.sol\`, escrow/settlement/auth \`.ts\`/\`.js\`) and call \`github_read_file\` ONCE per file/range.
     c) If BOTH an attached code file AND a GitHub repo are provided, audit the attached file AND cross-check how it interacts with the repository's contracts, escrow, and auth layers.
   - If a NEAR Mainnet account or contract ID (e.g. \`core.cryptozax.near\`, \`intents.near\`) is mentioned:
     Call \`near_rpc_view\` (\`get_account_state\`) IN PARALLEL with \`github_repo_tree\` in Round 1! Only cite the exact \`amount\`, \`storage_usage\`, and \`code_hash\` returned by \`near_rpc_view\`.
     CRITICAL ANTI-HALLUCINATION RULE: NEVER invent or guess a NEAR balance, storage_usage, block_height, or code_hash. If \`near_rpc_view\` was NOT executed or returned an error, write "Not verified (near_rpc_view not executed)".

2. MANDATORY SECURITY AUDIT CHECKLIST (VERIFY EVERY APPLICABLE ITEM):
   - Access Control & Caller Auth: \`predecessor_account_id\` vs \`signer_account_id\`, \`ft_on_transfer\` \`sender_id\` authorization/allowlist, admin/operator privilege escalation.
   - State Machine & Reentrancy / Race Conditions: state updates before cross-contract promises, settlement locks, callback rollback on promise failure.
   - Gas & Async Promise Safety: \`with_static_gas\`, prepaid gas checks, stuck funds / claimable fallback handling.
   - Arithmetic, Storage & Input Validation: checked arithmetic, zero-hash or duplicate receipt checks, storage deposit accounting leaks.
   - Backend / API / Auth (if server code is in scope): wallet-session verification, signature replay/expiry, concurrent DB write races, secret redaction.

3. ERROR-RECOVERY RULES ("IF THIS HAPPENS, DO THAT"):
   - If \`github_read_file\` returns 404 or not found -> immediately use \`github_search_code\` to locate the real path; NEVER retry the exact same failing path.
   - If \`near_rpc_view\` fails for a custom contract method -> fall back to \`get_account_state\` / \`get_balance\` and report the exact RPC response or error honestly.
   - If you see \`[CACHED DUPLICATE CALL]\` or are on the final round -> STOP calling tools immediately and synthesize the complete final Markdown report with all verified findings.

4. STRICT OUTPUT FORMAT (REQUIRED FOR PREVIEW & FULL REPORT):
   Use these exact headings in order:
   # Security Audit Report
   ## Executive Summary
   (2-3 crisp sentences summarizing audited scope, live RPC verification status, and overall risk rating.)

   ## Top Findings Summary
   - **[CRITICAL|HIGH|MEDIUM|LOW]** <Short Finding Title> — \`<file_path>:<line_range>\` (<1-sentence impact>)
   (List the top 3-5 verified findings as concise bullets here. Do NOT put code blocks in this section.)

   ## Detailed Findings & Remediation
   ### 1. [SEVERITY] <Title>
   - **File:** \`<path>\` (lines \`<X-Y>\`)
   - **Issue:** ...
   - **Vulnerable Code:** (exact code snippet)
   - **Exploit Scenario:** ...
   - **Concrete Fix:** (exact patched code)

   ## Live NEAR Mainnet RPC Verification
   (Exact account state, NEAR balance, storage usage, and code hash from \`near_rpc_view\`, or "Not requested in scope.")

   ## Priority Action Plan
   (Ordered immediate -> short-term remediation checklist.)
`.trim();

export function getCapabilitySystemRules(capability?: string): string | null {
  const norm = normalizeCapability(capability);
  if (norm === "security-audit") {
    return SECURITY_AUDIT_RULES;
  }
  return null;
}

