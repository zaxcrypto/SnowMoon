import test from "node:test";
import assert from "node:assert/strict";
import {
  assertValidMarketHandle,
  discoverNearMarketAgents,
  hireBestMarketAgentWithFailover,
  hireNearMarketAgent,
  MAINNET_USDC_CONTRACT_ID,
} from "../src/near_market_x402.ts";
import { DeterministicSpendingPolicyEngine } from "../src/spending_policy.ts";
import { executeAgentTool } from "../src/agent_tools.ts";

const MARKET_TREASURY = "ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc";
const TEST_JOB_ID = "0x" + "ab".repeat(32);

test("assertValidMarketHandle blocks SSRF/path injection and allows clean handles", () => {
  assert.equal(assertValidMarketHandle("Web-Research"), "web-research");
  assert.throws(() => assertValidMarketHandle("evil.com/x"), /ERR_INVALID_MARKET_HANDLE/);
  assert.throws(() => assertValidMarketHandle("../internal"), /ERR_INVALID_MARKET_HANDLE/);
  assert.throws(() => assertValidMarketHandle("127.0.0.1:8080"), /ERR_INVALID_MARKET_HANDLE/);
});

test("discoverNearMarketAgents filters available USDC agents and attaches default pricing", async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/v1/agents?")) {
      return new Response(
        JSON.stringify({
          agents: [
            {
              agent_id: "ag-1",
              handle: "web-research",
              name: "Web Research",
              description: "Live cited research",
              category: "research",
              tags: ["Researcher"],
              delivered_jobs: 54,
              success_rate: 88,
              sla_seconds: 180,
              available_now: true,
              funding_paused: false,
              payable_with: ["USDC"],
            },
            {
              agent_id: "ag-2",
              handle: "offline-bot",
              name: "Offline Bot",
              available_now: false,
              funding_paused: false,
              payable_with: ["USDC"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.includes("/v1/agents/ag-1/pricing-plans")) {
      return new Response(
        JSON.stringify([{ is_default: true, price_amount: 0.05, sla_seconds: 120 }]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const results = await discoverNearMarketAgents({ query: "research", fetchImpl: mockFetch });
  assert.equal(results.length, 1);
  assert.equal(results[0].handle, "web-research");
  assert.equal(results[0].priceUsdc, "0.05");
  assert.equal(results[0].priceAtomic, "50000");
  assert.equal(results[0].slaSeconds, 120);
});

test("hireNearMarketAgent completes full 402 -> NEP-366 X-PAYMENT -> GetTask poll -> SpendingPolicy settlement", async () => {
  const policy = new DeterministicSpendingPolicyEngine();
  let getTaskCalls = 0;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://market.near.ai/.well-known/x402") {
      return new Response(
        JSON.stringify({
          x402Version: 2,
          recipients: [
            { network: "near:mainnet", asset: MAINNET_USDC_CONTRACT_ID, payTo: MARKET_TREASURY },
          ],
        }),
        { status: 200 }
      );
    }
    if (url === "https://web-research.market.near.ai/a2a/v1") {
      const body = JSON.parse(String(init?.body || "{}"));
      const headers = (init?.headers || {}) as Record<string, string>;
      if (body.method === "SendMessage" && !headers["X-PAYMENT"]) {
        return new Response(
          JSON.stringify({
            x402Version: 2,
            error: "x-payment header is required",
            accepts: [
              {
                scheme: "exact",
                network: "near:mainnet",
                asset: MAINNET_USDC_CONTRACT_ID,
                amount: "50000", // $0.05 USDC (within $0.10 auto-approve)
                payTo: MARKET_TREASURY,
                maxTimeoutSeconds: 600,
              },
            ],
          }),
          { status: 402 }
        );
      }
      if (body.method === "SendMessage" && headers["X-PAYMENT"] === "MOCK_BASE64_XPAYMENT") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              task: {
                id: "task-xyz-1",
                status: { state: "TASK_STATE_WORKING" },
              },
            },
          }),
          { status: 200 }
        );
      }
      if (body.method === "GetTask") {
        getTaskCalls += 1;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 11,
            result: {
              id: "task-xyz-1",
              status: { state: "TASK_STATE_COMPLETED" },
              artifacts: [
                {
                  artifactId: "art-1",
                  parts: [{ text: "Verified NEAR ecosystem research brief with citations." }],
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
    }
    return new Response("Unexpected", { status: 500 });
  };

  const res = await hireNearMarketAgent({
    handle: "web-research",
    prompt: "NEAR Audit\nSummarize latest NEAR security advisories.",
    jobId: TEST_JOB_ID,
    maxBudgetAtomic: "100000",
    payerAccountId: "cryptozax.near",
    payerPrivateKey: "ed25519:mock",
    fetchImpl: mockFetch,
    policyEngine: policy,
    delegateSigner: async () => "MOCK_BASE64_XPAYMENT",
    pollIntervalMs: 1,
    maxPollAttempts: 3,
  });

  assert.equal(res.ok, true);
  assert.equal(res.state, "TASK_STATE_COMPLETED");
  assert.equal(res.paidAmountUsdc, "0.05");
  assert.equal(res.xPaymentHeaderUsed, true);
  assert.equal(getTaskCalls, 1);
  assert.match(res.outputText, /Verified NEAR ecosystem research brief/);

  // Budget enforcement: reject quote exceeding maxBudgetAtomic
  await assert.rejects(
    () =>
      hireNearMarketAgent({
        handle: "web-research",
        prompt: "Too expensive",
        jobId: TEST_JOB_ID,
        maxBudgetAtomic: "10000", // $0.01 < $0.05 quote
        payerAccountId: "cryptozax.near",
        payerPrivateKey: "ed25519:mock",
        fetchImpl: mockFetch,
        delegateSigner: async () => "MOCK_BASE64_XPAYMENT",
      }),
    /ERR_NEAR_MARKET_BUDGET_EXCEEDED/
  );
});

test("executeAgentTool wires discover_near_market_agents and hire_near_market_agent cleanly", async () => {
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/v1/agents?")) {
      return new Response(
        JSON.stringify({
          agents: [
            {
              agent_id: "ag-1",
              handle: "web-research",
              name: "Web Research",
              description: "Cited research",
              category: "research",
              delivered_jobs: 54,
              success_rate: 88,
              sla_seconds: 120,
              available_now: true,
              funding_paused: false,
              payable_with: ["USDC"],
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.includes("/pricing-plans")) {
      return new Response(JSON.stringify([{ is_default: true, price_amount: 0.05 }]), { status: 200 });
    }
    if (url.endsWith("/.well-known/x402")) {
      return new Response(
        JSON.stringify({
          x402Version: 2,
          recipients: [{ network: "near:mainnet", asset: MAINNET_USDC_CONTRACT_ID, payTo: MARKET_TREASURY }],
        }),
        { status: 200 }
      );
    }
    if (url === "https://web-research.market.near.ai/a2a/v1") {
      const headers = (init?.headers || {}) as Record<string, string>;
      if (!headers["X-PAYMENT"]) {
        return new Response(
          JSON.stringify({
            x402Version: 2,
            accepts: [
              {
                scheme: "exact",
                network: "near:mainnet",
                asset: MAINNET_USDC_CONTRACT_ID,
                amount: "50000",
                payTo: MARKET_TREASURY,
                maxTimeoutSeconds: 600,
              },
            ],
          }),
          { status: 402 }
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            task: {
              id: "task-direct-1",
              status: { state: "TASK_STATE_COMPLETED" },
              artifacts: [{ parts: [{ text: "Direct tool output ok" }] }],
            },
          },
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const disc = await executeAgentTool(
    "discover_near_market_agents",
    { query: "research" },
    { fetchImpl: mockFetch }
  );
  assert.equal(disc.ok, true);
  assert.match(disc.output, /@web-research/);

  const hire = await executeAgentTool(
    "hire_near_market_agent",
    { handle: "web-research", task_prompt: "Research NEAR" },
    {
      fetchImpl: mockFetch,
      jobId: TEST_JOB_ID,
      jobBudgetAtomic: "100000",
      spendingPolicy: new DeterministicSpendingPolicyEngine(),
      nearAccountId: "cryptozax.near",
      nearPrivateKey: "ed25519:mock",
      x402DelegateSigner: async () => "MOCK_X_PAYMENT",
    }
  );
  assert.equal(hire.ok, true);
  assert.match(hire.output, /Direct tool output ok/);
});

test("hireBestMarketAgentWithFailover fails over to backup agent and falls back to native AI when all fail", async () => {
  const mkFetch = (backupSucceeds: boolean): typeof fetch => async (input, init) => {
    const url = String(input);
    if (url.endsWith("/.well-known/x402")) {
      return new Response(
        JSON.stringify({
          x402Version: 2,
          recipients: [{ network: "near:mainnet", asset: MAINNET_USDC_CONTRACT_ID, payTo: MARKET_TREASURY }],
        }),
        { status: 200 }
      );
    }
    if (url === "https://agent-primary.market.near.ai/a2a/v1") {
      return new Response("Upstream agent unavailable", { status: 503 });
    }
    if (url === "https://agent-backup.market.near.ai/a2a/v1") {
      const headers = (init?.headers || {}) as Record<string, string>;
      if (!headers["X-PAYMENT"]) {
        return new Response(
          JSON.stringify({
            x402Version: 2,
            accepts: [
              {
                scheme: "exact",
                network: "near:mainnet",
                asset: MAINNET_USDC_CONTRACT_ID,
                amount: "50000",
                payTo: MARKET_TREASURY,
                maxTimeoutSeconds: 600,
              },
            ],
          }),
          { status: 402 }
        );
      }
      if (!backupSucceeds) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { task: { id: "t-fail", status: { state: "TASK_STATE_FAILED" } } },
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            task: {
              id: "t-ok",
              status: { state: "TASK_STATE_COMPLETED" },
              artifacts: [{ parts: [{ text: "Backup agent audit complete" }] }],
            },
          },
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  // Case 1: primary fails -> backup succeeds
  const res1 = await hireBestMarketAgentWithFailover({
    primaryHandle: "agent-primary",
    fallbackHandles: ["agent-backup"],
    prompt: "Audit contract",
    jobId: TEST_JOB_ID,
    maxBudgetAtomic: "100000",
    payerAccountId: "cryptozax.near",
    payerPrivateKey: "ed25519:mock",
    fetchImpl: mkFetch(true),
    policyEngine: new DeterministicSpendingPolicyEngine(),
    delegateSigner: async () => "MOCK_X_PAYMENT",
    pollIntervalMs: 0,
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.fallbackToNativeAi, false);
  assert.equal(res1.usedHandle, "agent-backup");
  assert.equal(res1.attempts.length, 2);
  assert.equal(res1.attempts[0].ok, false);
  assert.equal(res1.attempts[1].ok, true);

  // Case 2: both fail -> clean fallbackToNativeAi=true without throwing
  const res2 = await hireBestMarketAgentWithFailover({
    primaryHandle: "agent-primary",
    fallbackHandles: ["agent-backup"],
    prompt: "Audit contract",
    jobId: TEST_JOB_ID,
    maxBudgetAtomic: "100000",
    payerAccountId: "cryptozax.near",
    payerPrivateKey: "ed25519:mock",
    fetchImpl: mkFetch(false),
    policyEngine: new DeterministicSpendingPolicyEngine(),
    delegateSigner: async () => "MOCK_X_PAYMENT",
    pollIntervalMs: 0,
  });
  assert.equal(res2.ok, false);
  assert.equal(res2.fallbackToNativeAi, true);
  assert.equal(res2.attempts.length, 2);
});

