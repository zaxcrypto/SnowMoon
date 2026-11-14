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
  if (raw === "code" || raw === "code-review" || raw === "code_review") {
    return "code-review";
  }
  if (raw === "research") {
    return "research";
  }
  if (raw === "summary" || raw === "summarization") {
    return "summarization";
  }
  if (raw === "extract" || raw === "data-extraction" || raw === "data_extraction") {
    return "data-extraction";
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

3. ERROR-RECOVERY & HYBRID MARKETPLACE RULES ("IF THIS HAPPENS, DO THAT"):
   - LEAST-COST & HYBRID DELEGATION: If a NEAR Mainnet contract/account is in scope (or external specialist verification is requested) AND remaining job budget is >= $0.10 USDC, you may call \`discover_near_market_agents\` (pick the cheapest reliable specialist <= $0.10-$0.25 USDC; NEVER spend the full job/float budget on one hire) and \`hire_near_market_agent\` (pass \`fallback_query\` so it automatically fails over up to 2 agents).
   - MANDATORY NATIVE FALLBACK: If \`hire_near_market_agent\` returns \`MARKETPLACE_FALLBACK_TO_NATIVE_AI\` (both marketplace agents failed/timed out/exceeded budget), DO NOT stop, DO NOT retry marketplace hires, and DO NOT fail the job — immediately complete the full Security Audit natively using NEAR AI + \`github_*\` + \`near_rpc_view\`, note the marketplace status transparently, and deliver the full report.
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

const CODE_REVIEW_RULES = `
CAPABILITY PROFILE: CODE REVIEW (MANDATORY PROTOCOL)
Apply these rules strictly because this job's capability is "code-review" (focus on engineering quality, correctness, performance, and maintainability — do NOT turn this into a generic security audit unless a critical bug directly breaks safety):

1. INPUT & TOOL EXECUTION WORKFLOW (ANTI-BURN — NO DUPLICATE CALLS):
   - If an "--- ATTACHED CODE FILE: <filename> ---" block is present:
     Review the attached file line-by-line first, citing exact filename and line numbers.
   - If a GitHub repository URL or PR is present:
     a) Call \`github_repo_tree\` ONCE to understand project structure.
     b) Read 3-4 core implementation/module files with \`github_read_file\` ONCE per file/range.
   - If you see \`[CACHED DUPLICATE CALL]\` or are on the final round -> STOP calling tools immediately and produce the complete review.

2. MANDATORY CODE REVIEW CHECKLIST:
   - Correctness & Edge Cases: null/undefined handling, boundary conditions, async/Promise error handling, race conditions.
   - Architecture & Modularity: separation of concerns, duplicated logic, overly long functions, type safety.
   - Performance & Resource Usage: N+1 queries/loops, unnecessary re-renders/allocations, blocking I/O, missing timeouts.
   - Testability & DX: missing unit/integration test coverage, unclear naming, error messages, API ergonomics.

3. STRICT OUTPUT FORMAT (REQUIRED FOR PREVIEW & FULL REPORT):
   # Code Review Report
   ## Executive Summary
   (2-3 sentences covering code quality score/readiness, strengths, and top refactoring priorities.)

   ## Top Review Findings
   - **[BUG|REFACTOR|PERF|TEST|STYLE]** <Short Title> — \`<file_path>:<line_range>\` (<1-sentence reason>)

   ## Detailed Suggestions & Patch Snippets
   ### 1. [CATEGORY] <Title>
   - **File:** \`<path>\` (lines \`<X-Y>\`)
   - **Current Code:** (exact snippet)
   - **Suggested Improvement:** (clean drop-in patch or refactored snippet)
   - **Why:** (concise engineering rationale)

   ## Test & Merge Readiness Checklist
   (Actionable checklist before merging.)
`.trim();

const RESEARCH_RULES = `
CAPABILITY PROFILE: RESEARCH (MANDATORY PROTOCOL)
Apply these rules strictly because this job's capability is "research":

1. LIVE VERIFICATION & TOOL WORKFLOW:
   - NEVER fabricate prices, TVL, market caps, dates, versions, or statistics from memory.
   - Use \`web_search\` and \`fetch_url\` for live web/market/documentation facts, \`near_docs_search\` for NEAR Protocol specs, and \`near_rpc_view\` for live NEAR Mainnet state.
   - HYBRID MARKETPLACE DELEGATION: If specialized real-time data/research is needed AND remaining job budget is >= $0.10 USDC, you may call \`discover_near_market_agents\` (cheapest reliable <= $0.10-$0.25) and \`hire_near_market_agent\` (with \`fallback_query\`). If it returns \`MARKETPLACE_FALLBACK_TO_NATIVE_AI\`, immediately finish natively using \`web_search\` / \`fetch_url\` / \`near_rpc_view\`.

2. STRICT CITATION RULE:
   - Every external fact or metric MUST include the exact UTC timestamp and source URL.
   - If a source could not be reached, state "Unverified (source unreachable)" transparently.

3. STRICT OUTPUT FORMAT:
   # Research Report
   ## Executive Summary
   (3-4 crisp sentences answering the core research question directly.)

   ## Key Findings & Live Evidence
   (Structured bullets with metrics, UTC timestamps, and source URLs.)

   ## Comparison / Data Matrix
   (Markdown table comparing options, protocols, metrics, or sources.)

   ## Sources & Verification Log
   (Clickable URLs and timestamps checked.)
`.trim();

const ANALYSIS_RULES = `
CAPABILITY PROFILE: ANALYSIS (MANDATORY PROTOCOL)
Apply these rules strictly because this job's capability is "analysis":

1. INPUT & EVIDENCE WORKFLOW:
   - Analyze any attached file, text, metrics, or repository thoroughly first.
   - Use \`web_search\`, \`fetch_url\`, or \`near_rpc_view\` ONLY when external verification or live numbers are needed to support the analysis.
   - Never invent numbers; distinguish observed facts from inferences clearly.

2. MANDATORY ANALYTICAL FRAMEWORK:
   - Break down root causes, patterns, trade-offs, risks, and opportunities systematically.
   - Quantify impact wherever data is available.

3. STRICT OUTPUT FORMAT:
   # Analysis Report
   ## Executive Summary
   (Clear 2-3 sentence bottom-line conclusion.)

   ## Key Insights & Breakdown
   (Structured thematic sections with supporting evidence.)

   ## Trade-Offs / Risk Matrix
   (Markdown table: Factor | Impact | Likelihood / Effort | Recommendation.)

   ## Actionable Recommendations
   (Prioritized next steps: Immediate vs Short-Term.)
`.trim();

const SUMMARIZATION_RULES = `
CAPABILITY PROFILE: SUMMARIZATION (MANDATORY PROTOCOL)
Apply these rules strictly because this job's capability is "summarization":

1. STRICT FIDELITY & ANTI-HALLUCINATION:
   - Summarize ONLY what is present in the attached file, URL (\`fetch_url\`), or task input.
   - Do NOT add outside opinions, invented numbers, or unrelated code/security advice.
   - Keep it tight, high-signal, and scannable — preserve exact names, numbers, dates, and decisions.

2. STRICT OUTPUT FORMAT:
   # Executive Summary
   ## TL;DR
   (2-3 sentences capturing the entire core message.)

   ## Key Takeaways
   (5-8 concise bullet points covering the most important facts.)

   ## Decisions, Metrics & Action Items
   (Bullet list of concrete decisions, deadlines, owners, or figures mentioned; write "None stated." if absent.)
`.trim();

const DATA_EXTRACTION_RULES = `
CAPABILITY PROFILE: DATA EXTRACTION (MANDATORY PROTOCOL)
Apply these rules strictly because this job's capability is "data-extraction":

1. STRICT EXTRACTION ACCURACY:
   - Extract ONLY verifiable fields present in the input text, attached file, or fetched URL/RPC response.
   - If a field is missing or ambiguous, output \`null\` (or \`"N/A"\`) — NEVER guess or synthesize missing values.
   - Normalize dates to ISO-8601 (\`YYYY-MM-DD\`) and numbers/currencies cleanly where possible.

2. STRICT OUTPUT FORMAT:
   # Extracted Data Output
   ## Extraction Summary
   (1-2 sentences stating source, record count, and any missing fields.)

   ## Structured JSON
   \`\`\`json
   {
     "records": []
   }
   \`\`\`

   ## Tabular Preview
   (Clean Markdown table mirroring the extracted JSON records.)
`.trim();

const CAPABILITY_RULES_MAP: Record<string, string> = {
  "security-audit": SECURITY_AUDIT_RULES,
  "code-review": CODE_REVIEW_RULES,
  research: RESEARCH_RULES,
  analysis: ANALYSIS_RULES,
  summarization: SUMMARIZATION_RULES,
  "data-extraction": DATA_EXTRACTION_RULES,
};

export function getCapabilitySystemRules(capability?: string): string | null {
  const norm = normalizeCapability(capability);
  return CAPABILITY_RULES_MAP[norm] ?? ANALYSIS_RULES;
}

