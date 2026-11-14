import test from "node:test";
import assert from "node:assert/strict";
import { isSafePublicHttpUrl, selectModelForTask } from "../src/agent_tools.ts";
import { getCapabilitySystemRules } from "../src/capability_rules.ts";
import { AIWorkerAdapter } from "../src/adapters.ts";
import { loadConfig } from "../src/config.ts";
import type { JobRecord } from "../src/engine.ts";

test("selectModelForTask routes security audits, code, research, and fast tasks by capability & budget", () => {
  // Enterprise ($25+): flagship Opus 4.7
  const enterpriseAudit = selectModelForTask({
    capability: "audit",
    prompt: "Audit https://github.com/example/contract for reentrancy and access control vulnerabilities",
    amountAtomic: "25000000",
  });
  assert.equal(enterpriseAudit.tier, "tier3_audit");
  assert.equal(enterpriseAudit.primaryModel, "anthropic/claude-opus-4-7");
  assert.equal(enterpriseAudit.criticModel, "anthropic/claude-sonnet-4-6");

  // Growth ($5-$24.99, e.g. $10 USDC): Sonnet 4.6 sweet spot (neither lite nor Opus burn)
  const growthAudit = selectModelForTask({
    capability: "audit",
    prompt: "Audit https://github.com/example/contract for reentrancy and access control vulnerabilities",
    amountAtomic: "10000000",
  });
  assert.equal(growthAudit.tier, "tier3_audit");
  assert.equal(growthAudit.primaryModel, "anthropic/claude-sonnet-4-6");
  assert.equal(growthAudit.criticModel, "deepseek/deepseek-v3.2");

  // Standard ($0.10-$0.99): DeepSeek v3.2
  const standardAudit = selectModelForTask({
    capability: "security-audit",
    prompt: "Audit https://github.com/example/contract for vulnerabilities",
    amountAtomic: "100000",
  });
  assert.equal(standardAudit.tier, "tier3_audit");
  assert.equal(standardAudit.primaryModel, "deepseek/deepseek-v3.2");
  assert.equal(standardAudit.criticModel, undefined);

  // Micro ($0.01): Gemini 2.5 Flash-Lite (loss-proof)
  const microAudit = selectModelForTask({
    capability: "security-audit",
    prompt: "Audit https://github.com/example/contract for vulnerabilities",
    amountAtomic: "10000",
  });
  assert.equal(microAudit.tier, "tier3_audit");
  assert.equal(microAudit.primaryModel, "google/gemini-2.5-flash-lite");

  const codePlan = selectModelForTask({
    capability: "code-review",
    prompt: "Review https://github.com/example/app TypeScript architecture",
    amountAtomic: "100000",
  });
  assert.equal(codePlan.tier, "tier2_code");
  assert.equal(codePlan.primaryModel, "deepseek/deepseek-v3.2");

  const researchPlan = selectModelForTask({
    capability: "research",
    prompt: "Find today's top 10 cryptocurrencies by live market cap",
    amountAtomic: "100000",
  });
  assert.equal(researchPlan.tier, "tier2_research");
  assert.equal(researchPlan.primaryModel, "deepseek/deepseek-v3.2");

  const fastPlan = selectModelForTask({
    capability: "analysis",
    prompt: "Summarize these 3 bullet points cleanly",
    amountAtomic: "10000",
  });
  assert.equal(fastPlan.tier, "tier1_fast");
  assert.equal(fastPlan.primaryModel, "google/gemini-2.5-flash-lite");
});

test("isSafePublicHttpUrl blocks SSRF targets and allows public HTTPS URLs", () => {
  assert.equal(isSafePublicHttpUrl("https://api.github.com/repos/near/nearcore"), true);
  assert.equal(isSafePublicHttpUrl("http://127.0.0.1:8091/api/state"), false);
  assert.equal(isSafePublicHttpUrl("http://localhost:3000"), false);
  assert.equal(isSafePublicHttpUrl("http://169.254.169.254/latest/meta-data/"), false);
  assert.equal(isSafePublicHttpUrl("http://10.0.0.5/internal"), false);
  assert.equal(isSafePublicHttpUrl("http://192.168.1.1/admin"), false);
  assert.equal(isSafePublicHttpUrl("file:///etc/passwd"), false);
});

test("AIWorkerAdapter executes multi-turn tool_calls loop and accumulates token usage", async () => {
  const cfg = loadConfig();
  cfg.aiMode = "near_ai";
  cfg.secrets.nearAiApiKey = "test-near-ai-key";
  cfg.isProductionMode = false;

  let turn = 0;
  const mockFetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/chat/completions")) {
      turn += 1;
      if (turn === 1) {
        return new Response(
          JSON.stringify({
            id: "req-turn-1",
            model: "google/gemini-2.5-flash",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "fetch_url",
                        arguments: JSON.stringify({ url: "https://example.com/live-data.json" }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          id: "req-turn-2",
          model: "google/gemini-2.5-flash",
          choices: [
            {
              message: {
                role: "assistant",
                content: "Live verified result: BTC $91,000 from https://example.com/live-data.json",
              },
            },
          ],
          usage: { prompt_tokens: 180, completion_tokens: 40, total_tokens: 220 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url === "https://example.com/live-data.json") {
      return new Response(JSON.stringify({ btc: 91000 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  const adapter = new AIWorkerAdapter(cfg, mockFetch);
  const job: JobRecord = {
    seq: 1,
    jobId: "0x" + "11".repeat(32),
    title: "Live Research [capability:research]",
    taskDescription: "Get live BTC price today",
    customer: "alice.near",
    sponsor: "alice.near",
    operator: "worker.near",
    customerPayment: "10000",
    maxOperatingBudget: "0",
    operatingSpent: "0",
    advanceId: 0,
    storageLockedYocto: "0",
    anchored: false,
    termsHash: "0x" + "22".repeat(32),
    deliveryHash: "0x" + "00".repeat(32),
    deadlineSec: 1900000000,
    state: "InProgress",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expenses: [],
  };

  const res = await adapter.executeJobTask(job);
  assert.equal(res.adapterMode, "near_ai");
  assert.equal(res.model, "google/gemini-2.5-flash");
  assert.equal(res.tokenUsage?.totalTokens, 340);
  assert.match(res.deliverableMarkdown, /Agentic Tools Executed \(1\)/);
  assert.match(res.deliverableMarkdown, /fetch_url/);
  assert.match(res.deliverableMarkdown, /BTC \$91,000/);
});

test("all 6 capabilities have isolated rules and code-review is never hijacked by audit keywords", () => {
  const caps = [
    "security-audit",
    "code-review",
    "research",
    "analysis",
    "summarization",
    "data-extraction",
  ];
  const seen = new Set<string>();
  for (const cap of caps) {
    const rules = getCapabilitySystemRules(cap);
    assert.ok(rules && rules.length > 100, `Expected non-empty rules for ${cap}`);
    assert.ok(!seen.has(rules), `Expected distinct rules for ${cap}`);
    seen.add(rules);
  }

  const codeReviewWithAuditWords = selectModelForTask({
    capability: "code-review",
    prompt: "Review this smart contract for bugs and clean architecture",
    amountAtomic: "1000000",
  });
  assert.equal(codeReviewWithAuditWords.tier, "tier2_code");
});
