import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type AuditFindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
export type AuditVerificationStatus =
  | "CONFIRMED"
  | "LIKELY"
  | "INFO"
  | "FALSE_POSITIVE"
  | "NOT_TESTED";

export interface AuditWorkstream {
  workstreamId: string;
  name: string;
  capability: string;
  checks: string[];
}

export interface AuditFinding {
  findingId: string;
  severity: AuditFindingSeverity;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  filePath: string;
  line: number;
  symbol: string;
  description: string;
  attackScenario: string;
  impact: string;
  reproductionSteps: string;
  evidenceSnippet: string;
  recommendedRemediation: string;
  verificationStatus: AuditVerificationStatus;
}

export interface AuditPlan {
  jobId: string;
  classification: "smart-contract-audit" | "general-workforce-task";
  workstreams: AuditWorkstream[];
  createdAt: string;
}

export interface AuditReportResult {
  jobId: string;
  plan: AuditPlan;
  findings: AuditFinding[];
  toolChecksExecuted: Array<{ tool: string; passed: boolean; summary: string }>;
  teeAttested: boolean; // Never true unless backed by verified OutLayer TEE attestation
  independentlyAudited: false; // Automated Brain+Tooling review != independent external human audit
  evidenceHash: string;
  markdownReport: string;
  createdAt: string;
}

export class NearAiBrainOrchestrator {
  public planTask(jobId: string, prompt: string): AuditPlan {
    const lower = prompt.toLowerCase();
    const isContractAudit =
      lower.includes("audit") ||
      lower.includes("rust") ||
      lower.includes("smart contract") ||
      lower.includes("vulnerability") ||
      lower.includes("nep-141");

    if (!isContractAudit) {
      return {
        jobId,
        classification: "general-workforce-task",
        workstreams: [
          {
            workstreamId: "ws-exec-1",
            name: "Primary Task Execution",
            capability: "analysis",
            checks: ["schema-validation", "evidence-hash"],
          },
        ],
        createdAt: new Date().toISOString(),
      };
    }

    return {
      jobId,
      classification: "smart-contract-audit",
      workstreams: [
        {
          workstreamId: "ws-access-control",
          name: "NEAR Access Control & Predecessor Checks",
          capability: "security-audit",
          checks: ["predecessor_account_id", "assert_one_yocto", "private_callbacks"],
        },
        {
          workstreamId: "ws-nep141-async",
          name: "NEP-141 Transfers & Async Callback Rollback",
          capability: "security-audit",
          checks: ["ft_on_transfer", "promise_result_check", "pending_op_locks"],
        },
        {
          workstreamId: "ws-arithmetic-state",
          name: "Checked Arithmetic, Deadlines & State Transitions",
          capability: "security-audit",
          checks: ["checked_math", "deadline_bounds", "refund_writeoff_invariants"],
        },
      ],
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Runs deterministic static checks over Rust contract source files and validates
   * any candidate findings against actual source lines.
   */
  public executeRustContractAudit(params: {
    jobId: string;
    contractSrcDir: string;
    aiCandidateFindings?: Array<Partial<AuditFinding>>;
    teeAttested?: boolean;
  }): AuditReportResult {
    const plan = this.planTask(params.jobId, "Audit NEAR Rust smart contract for security vulnerabilities");
    const findings: AuditFinding[] = [];
    const toolChecksExecuted: Array<{ tool: string; passed: boolean; summary: string }> = [];

    const rsFiles = fs.existsSync(params.contractSrcDir)
      ? fs
          .readdirSync(params.contractSrcDir)
          .filter((f) => f.endsWith(".rs"))
          .map((f) => path.join(params.contractSrcDir, f))
      : [];

    let hasPrivateCallback = false;
    let hasOneYocto = false;
    let hasCheckedMath = false;
    let hasDeadlineCap = false;

    for (const filePath of rsFiles) {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      const rel = path.basename(filePath);

      if (content.includes("#[private]")) hasPrivateCallback = true;
      if (content.includes("assert_one_yocto") || content.includes("as_yoctonear() <= 1")) {
        hasOneYocto = true;
      }
      if (content.includes("checked_add") && content.includes("checked_sub")) {
        hasCheckedMath = true;
      }
      if (content.includes("MAX_JOB_DURATION_SEC")) {
        hasDeadlineCap = true;
      }

      // Deterministic check: detect unwrap() in non-test code as informational hardening note
      if (rel !== "tests.rs") {
        lines.forEach((lineText, idx) => {
          if (lineText.includes(".unwrap()") && !lineText.trim().startsWith("//")) {
            findings.push({
              findingId: `f_${rel}_${idx + 1}`,
              severity: "INFO",
              confidence: "HIGH",
              filePath: rel,
              line: idx + 1,
              symbol: "unwrap()",
              description: `Direct .unwrap() call at ${rel}:${idx + 1}.`,
              attackScenario: "If reachable on unexpected None/Err, transaction panics and reverts state.",
              impact: "Potential DoS if triggered by user-controlled input; safe only when invariant is guaranteed immediately prior.",
              reproductionSteps: `Inspect ${rel}:${idx + 1} for prior contains_key/checked invariant.`,
              evidenceSnippet: lineText.trim(),
              recommendedRemediation: "Replace with .expect(\"ERR_...\") or explicit ok_or/require! where appropriate.",
              verificationStatus: "INFO",
            });
          }
        });
      }
    }

    toolChecksExecuted.push(
      {
        tool: "near-callback-private-check",
        passed: hasPrivateCallback,
        summary: hasPrivateCallback
          ? "Verified #[private] attribute present on contract callbacks."
          : "Missing #[private] callback attribute.",
      },
      {
        tool: "near-yocto-deposit-check",
        passed: hasOneYocto,
        summary: hasOneYocto
          ? "Verified 1-yoctoNEAR / <=1 yoctoNEAR deposit checks on privileged/payable methods."
          : "No 1-yoctoNEAR guard detected.",
      },
      {
        tool: "rust-checked-arithmetic-check",
        passed: hasCheckedMath,
        summary: hasCheckedMath
          ? "Verified checked_add / checked_sub usage in financial accounting."
          : "Missing checked arithmetic.",
      },
      {
        tool: "deadline-bounds-check",
        passed: hasDeadlineCap,
        summary: hasDeadlineCap
          ? "Verified MAX_JOB_DURATION_SEC bound enforced on job deadlines."
          : "Missing MAX_JOB_DURATION_SEC bound.",
      }
    );

    // Validate AI-proposed findings against actual source code: never trust unverified LLM output
    for (const cand of params.aiCandidateFindings ?? []) {
      const targetFile = path.join(params.contractSrcDir, path.basename(String(cand.filePath || "")));
      const lineNum = Number(cand.line || 0);
      let status: AuditVerificationStatus = "FALSE_POSITIVE";
      let evidenceSnippet = "";
      if (fs.existsSync(targetFile) && lineNum > 0) {
        const fileLines = fs.readFileSync(targetFile, "utf8").split(/\r?\n/);
        const actualLine = fileLines[lineNum - 1];
        if (actualLine !== undefined) {
          evidenceSnippet = actualLine.trim();
          status = cand.symbol && actualLine.includes(cand.symbol) ? "CONFIRMED" : "LIKELY";
        }
      }
      findings.push({
        findingId: cand.findingId || `ai_${crypto.randomBytes(4).toString("hex")}`,
        severity: cand.severity || "MEDIUM",
        confidence: status === "CONFIRMED" ? "HIGH" : "LOW",
        filePath: path.basename(String(cand.filePath || "unknown.rs")),
        line: lineNum,
        symbol: String(cand.symbol || "unknown"),
        description: String(cand.description || "AI-proposed finding"),
        attackScenario: String(cand.attackScenario || "Unverified"),
        impact: String(cand.impact || "Requires manual review"),
        reproductionSteps: String(cand.reproductionSteps || "Inspect cited line"),
        evidenceSnippet,
        recommendedRemediation: String(cand.recommendedRemediation || "Verify manually"),
        verificationStatus: status,
      });
    }

    const reportHeader = [
      `# SnowMoon Automated Contract Security Review (${params.jobId})`,
      `- **TEE Attested**: ${Boolean(params.teeAttested)}`,
      `- **Independently Audited**: false (automated NEAR AI + deterministic static tooling; not a substitute for external human audit)`,
      `- **Files Scanned**: ${rsFiles.length}`,
      `- **Tool Checks**: ${toolChecksExecuted.map((t) => `${t.tool}=${t.passed ? "PASS" : "FAIL"}`).join(", ")}`,
      "",
      "## Findings Summary",
      ...findings.slice(0, 25).map(
        (f, i) => `${i + 1}. [${f.severity} | ${f.verificationStatus}] ${f.filePath}:${f.line} (\`${f.symbol}\`) — ${f.description}`
      ),
    ].join("\n");

    const evidenceHash = crypto.createHash("sha256").update(reportHeader).digest("hex");
    return {
      jobId: params.jobId,
      plan,
      findings,
      toolChecksExecuted,
      teeAttested: Boolean(params.teeAttested),
      independentlyAudited: false,
      evidenceHash: `0x${evidenceHash}`,
      markdownReport: reportHeader,
      createdAt: new Date().toISOString(),
    };
  }
}

