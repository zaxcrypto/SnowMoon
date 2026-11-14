/**
 * SnowMoon Autonomous Agentic Tools & Multi-Model Router
 *
 * Gives NEAR AI Cloud workers (Claude, Gemini, GPT, DeepSeek, etc.) real-time
 * general-purpose agentic capabilities via OpenAI-compatible client-managed
 * tool calling:
 *  - Dynamic Model Router (selects optimal NEAR AI Cloud model by task & budget)
 *  - web_search: Live internet search
 *  - fetch_url: SSRF-protected live HTTP/API reader (with HTTP 402 / x402 detection)
 *  - github_repo_tree / github_read_file / github_search_code: Live GitHub repo auditing
 *  - near_rpc_view: Live NEAR Mainnet smart-contract view calls
 *  - near_docs_search: Live NEAR official docs lookup (https://docs.near.org/llms.txt)
 */

export type ModelTier =
  | "tier3_audit"
  | "tier2_code"
  | "tier2_research"
  | "tier1_fast";

export interface ModelRoutePlan {
  tier: ModelTier;
  primaryModel: string;
  fallbackModels: string[];
  criticModel?: string;
  maxTokens: number;
  maxToolRounds: number;
  reason: string;
}

export interface ToolCallTraceEntry {
  round: number;
  toolName: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  durationMs: number;
}

export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

import {
  discoverNearMarketAgents,
  hireBestMarketAgentWithFailover,
  type Nep366X402Signer,
} from "./near_market_x402.ts";
import { DeterministicSpendingPolicyEngine } from "./spending_policy.ts";

export interface AgentToolContext {
  fetchImpl: typeof fetch;
  nearRpcUrl?: string;
  githubToken?: string;
  jobId?: string;
  jobBudgetAtomic?: string;
  spendingPolicy?: DeterministicSpendingPolicyEngine;
  nearAccountId?: string;
  nearPrivateKey?: string;
  x402DelegateSigner?: Nep366X402Signer;
  onTrace?: (evt: { stage: string; status: string; title: string; detail?: string }) => void;
}

const AUDIT_KEYWORDS =
  /\b(audit|vulnerabilit(?:y|ies)|security|exploit|reentranc|penetration|pentest|cve|threat|smart\s*contract|overflow|access\s*control|impersonat|ssrf|xss|sqli|injection|bug\s*bounty)\b/i;
const CODE_KEYWORDS =
  /\b(github\.com|repo|repository|codebase|code\s*review|refactor|typescript|rust|solidity|smart\s*contract|implement|debug|architecture|pull\s*request)\b/i;
const RESEARCH_KEYWORDS =
  /\b(today|live|latest|current|price|market\s*cap|news|search|find|compare|report|top\s*\d+|202[5-9]|coingecko|defi|tvl)\b/i;

export function selectModelForTask(params: {
  capability?: string;
  prompt: string;
  amountAtomic?: string;
  defaultModel?: string;
}): ModelRoutePlan {
  const forced = (process.env.SNOWMOON_FORCE_MODEL || "").trim();
  const cap = (params.capability || "").toLowerCase();
  const prompt = params.prompt || "";
  const amount = Number(params.amountAtomic || "0");
  const validAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;

  // 5-band price-performance budget tiers (6-decimal USDC atomic units):
  // - enterprise: >= $25.00 (25_000_000) -> flagship Opus / GPT-5.4
  // - growth:     $5.00 - $24.99 (5_000_000) -> Sonnet 4.6 / Gemini 2.5 Pro (sweet spot for $10 jobs)
  // - pro:        $1.00 - $4.99 (1_000_000)  -> Gemini 2.5 Pro / Gemini 2.5 Flash
  // - standard:   $0.10 - $0.99 (100_000)    -> DeepSeek v3.2 / Gemini 2.5 Flash
  // - micro:      < $0.10 (< 100_000)        -> Gemini 2.5 Flash-Lite / DeepSeek v4.1 Flash (loss-proof at $0.01)
  const band =
    validAmount >= 25_000_000
      ? "enterprise"
      : validAmount >= 5_000_000
      ? "growth"
      : validAmount >= 1_000_000
      ? "pro"
      : validAmount >= 100_000
      ? "standard"
      : "micro";
  const usdLabel = `$${(validAmount / 1e6).toFixed(2)} USDC`;

  if (forced) {
    return {
      tier: "tier2_research",
      primaryModel: forced,
      fallbackModels: params.defaultModel && params.defaultModel !== forced ? [params.defaultModel] : [],
      maxTokens: 2500,
      maxToolRounds: 6,
      reason: `Forced via SNOWMOON_FORCE_MODEL=${forced}`,
    };
  }

  const isAudit =
    cap === "audit" ||
    cap === "security-audit" ||
    cap === "security_audit" ||
    (!cap && AUDIT_KEYWORDS.test(prompt));
  const isCode =
    !isAudit &&
    (cap === "code" ||
      cap === "code-review" ||
      cap === "code_review" ||
      (!cap && CODE_KEYWORDS.test(prompt)));
  const isResearch =
    !isAudit &&
    !isCode &&
    (cap === "research" || (!cap && RESEARCH_KEYWORDS.test(prompt)));

  if (isAudit) {
    const map = {
      enterprise: {
        primary: "anthropic/claude-opus-4-7",
        fallbacks: ["anthropic/claude-sonnet-4-6", "google/gemini-2.5-pro", "deepseek/deepseek-v3.2"],
        critic: "anthropic/claude-sonnet-4-6",
        maxTokens: 8000,
        maxToolRounds: 6,
      },
      growth: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["google/gemini-2.5-pro", "deepseek/deepseek-v3.2", "openai/gpt-5.4-mini"],
        critic: "deepseek/deepseek-v3.2",
        maxTokens: 6000,
        maxToolRounds: 6,
      },
      pro: {
        primary: "google/gemini-2.5-pro",
        fallbacks: ["deepseek/deepseek-v3.2", "anthropic/claude-haiku-4-5", "google/gemini-2.5-flash"],
        critic: undefined,
        maxTokens: 4500,
        maxToolRounds: 5,
      },
      standard: {
        primary: "deepseek/deepseek-v3.2",
        fallbacks: ["google/gemini-2.5-flash", "openai/gpt-5.4-mini", "google/gemini-2.5-flash-lite"],
        critic: undefined,
        maxTokens: 3500,
        maxToolRounds: 4,
      },
      micro: {
        primary: "google/gemini-2.5-flash-lite",
        fallbacks: ["deepseek/deepseek-v4.1-flash", "openai/gpt-5.4-nano"],
        critic: undefined,
        maxTokens: 1500,
        maxToolRounds: 2,
      },
    }[band];
    return {
      tier: "tier3_audit",
      primaryModel: map.primary,
      fallbackModels: map.fallbacks,
      criticModel: map.critic,
      maxTokens: map.maxTokens,
      maxToolRounds: map.maxToolRounds,
      reason: `Budget-proportional (${band}) audit routed to ${map.primary} (${usdLabel})`,
    };
  }

  if (isCode) {
    const map = {
      enterprise: {
        primary: "anthropic/claude-opus-4-7",
        fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4"],
        critic: "openai/gpt-5.4",
        maxTokens: 8000,
        maxToolRounds: 6,
      },
      growth: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["google/gemini-2.5-pro", "deepseek/deepseek-v3.2"],
        critic: undefined,
        maxTokens: 6000,
        maxToolRounds: 5,
      },
      pro: {
        primary: "google/gemini-2.5-pro",
        fallbacks: ["deepseek/deepseek-v3.2", "openai/gpt-5.4-mini"],
        critic: undefined,
        maxTokens: 4500,
        maxToolRounds: 5,
      },
      standard: {
        primary: "deepseek/deepseek-v3.2",
        fallbacks: ["google/gemini-2.5-flash", "google/gemini-2.5-flash-lite"],
        critic: undefined,
        maxTokens: 3500,
        maxToolRounds: 4,
      },
      micro: {
        primary: "google/gemini-2.5-flash-lite",
        fallbacks: ["deepseek/deepseek-v4.1-flash", "openai/gpt-5.4-nano"],
        critic: undefined,
        maxTokens: 1500,
        maxToolRounds: 2,
      },
    }[band];
    return {
      tier: "tier2_code",
      primaryModel: map.primary,
      fallbackModels: map.fallbacks,
      criticModel: map.critic,
      maxTokens: map.maxTokens,
      maxToolRounds: map.maxToolRounds,
      reason: `Budget-proportional (${band}) code task routed to ${map.primary} (${usdLabel})`,
    };
  }

  if (isResearch) {
    const map = {
      enterprise: {
        primary: "openai/gpt-5.4",
        fallbacks: ["anthropic/claude-sonnet-4-6", "google/gemini-2.5-pro"],
        maxTokens: 6000,
        maxToolRounds: 6,
      },
      growth: {
        primary: "google/gemini-2.5-pro",
        fallbacks: ["deepseek/deepseek-v3.2", "openai/gpt-5.4-mini"],
        maxTokens: 4500,
        maxToolRounds: 5,
      },
      pro: {
        primary: "google/gemini-2.5-flash",
        fallbacks: ["deepseek/deepseek-v3.2", "openai/gpt-5.4-mini"],
        maxTokens: 3500,
        maxToolRounds: 4,
      },
      standard: {
        primary: "deepseek/deepseek-v3.2",
        fallbacks: ["google/gemini-2.5-flash", "google/gemini-2.5-flash-lite"],
        maxTokens: 3000,
        maxToolRounds: 4,
      },
      micro: {
        primary: "google/gemini-2.5-flash-lite",
        fallbacks: ["deepseek/deepseek-v4.1-flash", "openai/gpt-5.4-nano"],
        maxTokens: 1500,
        maxToolRounds: 3,
      },
    }[band];
    return {
      tier: "tier2_research",
      primaryModel: map.primary,
      fallbackModels: map.fallbacks,
      maxTokens: map.maxTokens,
      maxToolRounds: map.maxToolRounds,
      reason: `Budget-proportional (${band}) research routed to ${map.primary} (${usdLabel})`,
    };
  }

  const fastMap = {
    enterprise: { primary: "openai/gpt-5.4", fallbacks: ["anthropic/claude-sonnet-4-6"], maxTokens: 4000, maxToolRounds: 5 },
    growth: { primary: "google/gemini-2.5-pro", fallbacks: ["google/gemini-2.5-flash", "deepseek/deepseek-v3.2"], maxTokens: 3500, maxToolRounds: 4 },
    pro: { primary: "google/gemini-2.5-flash", fallbacks: ["deepseek/deepseek-v3.2"], maxTokens: 2500, maxToolRounds: 4 },
    standard: { primary: "google/gemini-2.5-flash", fallbacks: ["google/gemini-2.5-flash-lite", "deepseek/deepseek-v3.2"], maxTokens: 2000, maxToolRounds: 4 },
    micro: { primary: "google/gemini-2.5-flash-lite", fallbacks: ["deepseek/deepseek-v4.1-flash", "openai/gpt-5.4-nano"], maxTokens: 1500, maxToolRounds: 3 },
  }[band];

  return {
    tier: "tier1_fast",
    primaryModel: fastMap.primary,
    fallbackModels: fastMap.fallbacks,
    maxTokens: fastMap.maxTokens,
    maxToolRounds: fastMap.maxToolRounds,
    reason: `Budget-proportional (${band}) fast task routed to ${fastMap.primary} (${usdLabel})`,
  };
}

export const AGENT_TOOL_DEFINITIONS: OpenAIToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the live internet for real-time facts, current prices, news, documentation, CVEs, or websites.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          max_results: {
            type: "integer",
            description: "Maximum number of results to return (1-10, default 6)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Fetch a live public HTTPS webpage or JSON API (e.g. CoinGecko, DefiLlama, GitHub raw, docs) and extract its text/JSON. Also detects HTTP 402 x402 payment requirements.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Public http(s) URL to fetch" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_repo_tree",
      description:
        "List the file tree of any public GitHub repository so you can locate source files, contracts, tests, and config before auditing.",
      parameters: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "GitHub URL (e.g. https://github.com/owner/repo) or owner/repo",
          },
          branch: {
            type: "string",
            description: "Optional branch name (defaults to repo default branch)",
          },
          path_prefix: {
            type: "string",
            description: "Optional path prefix filter (e.g. 'src/' or 'contracts/')",
          },
        },
        required: ["repo_url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_read_file",
      description:
        "Read the exact source code of a file in a public GitHub repository with line numbers.",
      parameters: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "GitHub URL (https://github.com/owner/repo) or owner/repo",
          },
          file_path: {
            type: "string",
            description: "Path to the file inside the repository (e.g. 'src/server.ts')",
          },
          branch: { type: "string", description: "Optional branch name (default: repo default)" },
          start_line: { type: "integer", description: "Optional 1-based start line (default 1)" },
          end_line: { type: "integer", description: "Optional 1-based end line (max 250 lines)" },
        },
        required: ["repo_url", "file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_search_code",
      description:
        "Search file paths and source code inside a public GitHub repository for a keyword or pattern (case-insensitive substring or regex).",
      parameters: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "GitHub URL (https://github.com/owner/repo) or owner/repo",
          },
          query: { type: "string", description: "Keyword or regex pattern to search for" },
          branch: { type: "string", description: "Optional branch name" },
        },
        required: ["repo_url", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "near_rpc_view",
      description:
        "Call a read-only view method on a NEAR Mainnet smart contract (e.g. core.cryptozax.near, audit.cryptozax.near, or any NEAR contract).",
      parameters: {
        type: "object",
        properties: {
          contract_id: { type: "string", description: "NEAR contract account ID" },
          method_name: { type: "string", description: "View method name" },
          args_json: {
            type: "string",
            description: "JSON string of arguments (default '{}')",
          },
        },
        required: ["contract_id", "method_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "near_docs_search",
      description:
        "Search official NEAR Protocol developer documentation (https://docs.near.org/llms.txt) for protocol, contract, or SDK details.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Topic or keyword to search in NEAR docs" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discover_near_market_agents",
      description:
        "Discover live specialized AI agents on the NEAR AI Agent Market (https://market.near.ai) that accept USDC via x402. Returns handle, category, success rate, SLA, and price in USDC.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keywords (e.g. 'research', 'security', 'solidity', 'data')" },
          category: {
            type: "string",
            description: "Optional category slug: research, dev_tools, finance, legal_compliance, automation, data, marketing, other",
          },
          max_price_usdc: { type: "number", description: "Optional maximum price per call in USDC" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hire_near_market_agent",
      description:
        "Hire a specialized agent from market.near.ai over A2A + x402 (near:mainnet USDC NEP-366 delegate payment), subject to SnowMoon SpendingPolicy and remaining job budget. Returns the specialist's completed artifact text.",
      parameters: {
        type: "object",
        properties: {
          handle: { type: "string", description: "The agent handle from discover_near_market_agents (e.g. 'web-research')" },
          task_prompt: { type: "string", description: "Clear task title on first line followed by the detailed brief" },
          max_budget_usdc: { type: "number", description: "Optional max USDC to spend on this hire (cannot exceed job budget)" },
        },
        required: ["handle", "task_prompt"],
      },
    },
  },
];

export function isSafePublicHttpUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localhost")
  ) {
    return false;
  }
  // Block IPv4 private/loopback/link-local ranges
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    ) {
      return false;
    }
  }
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return false;
  }
  return true;
}

function parseGitHubRepo(input: string): { owner: string; repo: string } {
  const cleaned = input.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  const urlMatch = cleaned.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2] };
  }
  const shortMatch = cleaned.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2] };
  }
  throw new Error(`Invalid GitHub repository identifier: ${input}`);
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripHtmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function githubHeaders(githubToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "SnowMoon-Autonomous-Agent/1.0",
    Accept: "application/vnd.github+json",
  };
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }
  return headers;
}

const DEFAULT_BRANCH_CACHE = new Map<string, { branch: string; expiresAt: number }>();

async function fetchWithToolTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
  timeoutMs = 12_000
): Promise<Response> {
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  return fetchImpl(url, signal ? { ...init, signal } : init);
}

async function resolveDefaultBranch(
  owner: string,
  repo: string,
  ctx: AgentToolContext
): Promise<string> {
  const key = `${owner}/${repo}`.toLowerCase();
  const cached = DEFAULT_BRANCH_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.branch;
  }
  const resp = await fetchWithToolTimeout(ctx.fetchImpl, `https://api.github.com/repos/${owner}/${repo}`, {
    headers: githubHeaders(ctx.githubToken),
  });
  if (!resp.ok) {
    return "main";
  }
  const data = (await resp.json()) as { default_branch?: string };
  const branch = data.default_branch || "main";
  DEFAULT_BRANCH_CACHE.set(key, { branch, expiresAt: Date.now() + 5 * 60_000 });
  return branch;
}

export async function executeAgentTool(
  toolName: string,
  rawArgs: Record<string, unknown>,
  ctx: AgentToolContext
): Promise<{ ok: boolean; output: string; summary: string }> {
  const rawFetch = ctx.fetchImpl;
  const toolTimeoutMs = toolName === "hire_near_market_agent" ? 90_000 : 12_000;
  const timedCtx: AgentToolContext = {
    ...ctx,
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
      fetchWithToolTimeout(rawFetch, String(input), init, toolTimeoutMs)) as typeof fetch,
  };
  ctx = timedCtx;
  try {
    if (toolName === "web_search") {
      const query = String(rawArgs.query || "").trim();
      if (!query) return { ok: false, output: "Error: query is required", summary: "empty query" };
      const maxResults = Math.min(10, Math.max(1, Number(rawArgs.max_results || 6)));
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const resp = await ctx.fetchImpl(searchUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Accept: "text/html",
        },
      });
      if (!resp.ok) {
        return {
          ok: false,
          output: `Search HTTP ${resp.status} ${resp.statusText}`,
          summary: `HTTP ${resp.status}`,
        };
      }
      const html = await resp.text();
      const results: Array<{ title: string; url: string; snippet: string }> = [];
      const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      const links: Array<{ url: string; title: string }> = [];
      let m: RegExpExecArray | null;
      while ((m = linkRegex.exec(html)) !== null && links.length < maxResults) {
        let href = decodeHtmlEntities(m[1]);
        const uddg = href.match(/[?&]uddg=([^&]+)/);
        if (uddg) {
          try {
            href = decodeURIComponent(uddg[1]);
          } catch {
            // keep original href
          }
        }
        links.push({ url: href, title: stripHtmlToText(m[2]) });
      }
      const snippets: string[] = [];
      while ((m = snippetRegex.exec(html)) !== null && snippets.length < maxResults) {
        snippets.push(stripHtmlToText(m[1]));
      }
      for (let i = 0; i < links.length; i++) {
        results.push({
          title: links[i].title,
          url: links[i].url,
          snippet: snippets[i] || "",
        });
      }
      if (results.length === 0) {
        const fallbackText = stripHtmlToText(html).slice(0, 2500);
        return {
          ok: true,
          output: JSON.stringify({ query, results: [], fallbackExcerpt: fallbackText }, null, 2),
          summary: `0 structured hits (returned excerpt)`,
        };
      }
      return {
        ok: true,
        output: JSON.stringify({ query, fetchedAtUtc: new Date().toISOString(), results }, null, 2),
        summary: `${results.length} results for "${query.slice(0, 40)}"`,
      };
    }

    if (toolName === "fetch_url") {
      const url = String(rawArgs.url || "").trim();
      if (!isSafePublicHttpUrl(url)) {
        return {
          ok: false,
          output: `ERR_SSRF_BLOCKED: Refusing to fetch non-public or invalid URL (${url}).`,
          summary: "SSRF blocked",
        };
      }
      const resp = await ctx.fetchImpl(url, {
        headers: {
          "User-Agent": "SnowMoon-Autonomous-Agent/1.0",
          Accept: "application/json, text/plain, text/html, */*",
        },
      });
      if (resp.status === 402) {
        const paymentReq =
          resp.headers.get("payment-required") ||
          resp.headers.get("x-payment-required") ||
          (await resp.text().catch(() => ""));
        return {
          ok: false,
          output: JSON.stringify({
            status: 402,
            x402PaymentRequired: true,
            url,
            paymentHeader: paymentReq.slice(0, 2000),
            note: "Endpoint requires x402 payment before returning data.",
          }),
          summary: `HTTP 402 (x402 required)`,
        };
      }
      const contentType = resp.headers.get("content-type") || "";
      const raw = await resp.text();
      if (!resp.ok) {
        return {
          ok: false,
          output: `HTTP ${resp.status} ${resp.statusText}: ${raw.slice(0, 1000)}`,
          summary: `HTTP ${resp.status}`,
        };
      }
      const body = contentType.includes("text/html")
        ? stripHtmlToText(raw)
        : raw;
      return {
        ok: true,
        output: `URL: ${url}\nFetched-At-UTC: ${new Date().toISOString()}\nContent-Type: ${contentType}\n\n${body.slice(0, 12000)}`,
        summary: `HTTP ${resp.status} (${Math.min(body.length, 12000)} chars)`,
      };
    }

    if (toolName === "github_repo_tree") {
      const { owner, repo } = parseGitHubRepo(String(rawArgs.repo_url || ""));
      const branch =
        String(rawArgs.branch || "").trim() || (await resolveDefaultBranch(owner, repo, ctx));
      const prefix = String(rawArgs.path_prefix || "").trim().replace(/^\/+/, "");
      const resp = await ctx.fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        { headers: githubHeaders(ctx.githubToken) }
      );
      if (!resp.ok) {
        return {
          ok: false,
          output: `GitHub tree API HTTP ${resp.status}: ${(await resp.text()).slice(0, 500)}`,
          summary: `HTTP ${resp.status}`,
        };
      }
      const data = (await resp.json()) as {
        truncated?: boolean;
        tree?: Array<{ path: string; type: string; size?: number }>;
      };
      const files = (data.tree || [])
        .filter((x) => x.type === "blob")
        .map((x) => ({ path: x.path, size: x.size ?? 0 }))
        .filter((x) => (!prefix ? true : x.path.startsWith(prefix)));
      return {
        ok: true,
        output: JSON.stringify(
          {
            repo: `${owner}/${repo}`,
            branch,
            totalFilesMatching: files.length,
            truncatedTree: Boolean(data.truncated),
            files: files.slice(0, 300),
          },
          null,
          2
        ),
        summary: `${files.length} files in ${owner}/${repo}@${branch}`,
      };
    }

    if (toolName === "github_read_file") {
      const { owner, repo } = parseGitHubRepo(String(rawArgs.repo_url || ""));
      const filePath = String(rawArgs.file_path || "").trim().replace(/^\/+/, "");
      if (!filePath) return { ok: false, output: "file_path is required", summary: "missing path" };
      const branch =
        String(rawArgs.branch || "").trim() || (await resolveDefaultBranch(owner, repo, ctx));
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${filePath}`;
      const resp = await ctx.fetchImpl(rawUrl, { headers: githubHeaders(ctx.githubToken) });
      if (!resp.ok) {
        return {
          ok: false,
          output: `GitHub raw HTTP ${resp.status} for ${filePath}`,
          summary: `HTTP ${resp.status}`,
        };
      }
      const text = await resp.text();
      const lines = text.split(/\r?\n/);
      const start = Math.max(1, Number(rawArgs.start_line || 1));
      const end = Math.min(lines.length, Math.max(start, Number(rawArgs.end_line || start + 249)), start + 249);
      const numbered = lines
        .slice(start - 1, end)
        .map((line, i) => `${start + i}: ${line}`)
        .join("\n");
      return {
        ok: true,
        output: `File: ${owner}/${repo}/${filePath} (branch: ${branch}, lines ${start}-${end} of ${lines.length})\n\n${numbered.slice(0, 14000)}`,
        summary: `Read ${filePath} L${start}-${end}`,
      };
    }

    if (toolName === "github_search_code") {
      const { owner, repo } = parseGitHubRepo(String(rawArgs.repo_url || ""));
      const query = String(rawArgs.query || "").trim();
      if (!query) return { ok: false, output: "query is required", summary: "empty query" };
      const branch =
        String(rawArgs.branch || "").trim() || (await resolveDefaultBranch(owner, repo, ctx));
      const treeResp = await ctx.fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        { headers: githubHeaders(ctx.githubToken) }
      );
      if (!treeResp.ok) {
        return {
          ok: false,
          output: `GitHub tree API HTTP ${treeResp.status}`,
          summary: `HTTP ${treeResp.status}`,
        };
      }
      const treeData = (await treeResp.json()) as {
        tree?: Array<{ path: string; type: string; size?: number }>;
      };
      const sourceFiles = (treeData.tree || [])
        .filter(
          (x) =>
            x.type === "blob" &&
            (x.size ?? 0) < 120_000 &&
            /\.(ts|tsx|js|jsx|rs|sol|go|py|toml|json|md|yml|yaml)$/i.test(x.path)
        )
        .map((x) => x.path);

      const qLower = query.toLowerCase();
      const pathMatches = sourceFiles.filter((p) => p.toLowerCase().includes(qLower)).slice(0, 25);
      // Scan up to 15 likely source files (prioritizing src/, contracts/, daemon/, lib/)
      const prioritized = [
        ...sourceFiles.filter((p) => /^(src|contracts|daemon|app|lib|server)\//i.test(p)),
        ...sourceFiles.filter((p) => !/^(src|contracts|daemon|app|lib|server)\//i.test(p)),
      ].slice(0, 15);

      const contentMatches: Array<{ path: string; line: number; text: string }> = [];
      let regex: RegExp | null = null;
      try {
        regex = new RegExp(query, "i");
      } catch {
        regex = null;
      }

      await Promise.all(
        prioritized.map(async (filePath) => {
          try {
            const r = await ctx.fetchImpl(
              `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${filePath}`,
              { headers: githubHeaders(ctx.githubToken) }
            );
            if (!r.ok) return;
            const txt = await r.text();
            const lines = txt.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              const hit = regex ? regex.test(lines[i]) : lines[i].toLowerCase().includes(qLower);
              if (hit) {
                contentMatches.push({
                  path: filePath,
                  line: i + 1,
                  text: lines[i].trim().slice(0, 180),
                });
                if (contentMatches.length >= 40) break;
              }
            }
          } catch {
            // ignore individual file fetch error
          }
        })
      );

      return {
        ok: true,
        output: JSON.stringify(
          {
            repo: `${owner}/${repo}`,
            query,
            pathMatches,
            contentMatches: contentMatches.slice(0, 40),
          },
          null,
          2
        ),
        summary: `${pathMatches.length} path + ${contentMatches.length} content hits`,
      };
    }

    if (toolName === "near_rpc_view") {
      const contractId = String(rawArgs.contract_id || "").trim();
      const methodName = String(rawArgs.method_name || "").trim();
      const argsJson = String(rawArgs.args_json || "{}").trim() || "{}";
      const rpcUrl = ctx.nearRpcUrl || "https://rpc.mainnet.fastnear.com";

      if (
        !methodName ||
        methodName === "get_account_state" ||
        methodName === "view_account" ||
        methodName === "get_balance"
      ) {
        const resp = await ctx.fetchImpl(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "snowmoon-agent",
            method: "query",
            params: {
              request_type: "view_account",
              finality: "final",
              account_id: contractId,
            },
          }),
        });
        const json = (await resp.json()) as {
          result?: {
            amount?: string;
            locked?: string;
            code_hash?: string;
            storage_usage?: number;
            block_height?: number;
            block_hash?: string;
          };
          error?: unknown;
        };
        if (json.error || !json.result) {
          return {
            ok: false,
            output: `NEAR RPC error: ${JSON.stringify(json.error || "empty result")}`,
            summary: "RPC error",
          };
        }
        return {
          ok: true,
          output: JSON.stringify({
            account_id: contractId,
            amount_yocto: json.result.amount,
            amount_near: (Number(json.result.amount || "0") / 1e24).toFixed(4),
            storage_usage: json.result.storage_usage,
            code_hash: json.result.code_hash,
            block_height: json.result.block_height,
            block_hash: json.result.block_hash,
          }),
          summary: `NEAR account ${contractId} verified`,
        };
      }

      const argsBase64 = Buffer.from(argsJson, "utf8").toString("base64");
      const resp = await ctx.fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "snowmoon-agent",
          method: "query",
          params: {
            request_type: "call_function",
            finality: "final",
            account_id: contractId,
            method_name: methodName,
            args_base64: argsBase64,
          },
        }),
      });
      const json = (await resp.json()) as {
        result?: { result?: number[] };
        error?: unknown;
      };
      if (json.error) {
        return {
          ok: false,
          output: `NEAR RPC error: ${JSON.stringify(json.error)}`,
          summary: "RPC error",
        };
      }
      const decoded = Buffer.from(json.result?.result || []).toString("utf8");
      return {
        ok: true,
        output: `Contract: ${contractId}::${methodName}\nResult:\n${decoded.slice(0, 10000)}`,
        summary: `NEAR view ${contractId}::${methodName}`,
      };
    }

    if (toolName === "near_docs_search") {
      const query = String(rawArgs.query || "").trim().toLowerCase();
      const resp = await ctx.fetchImpl("https://docs.near.org/llms.txt", {
        headers: { "User-Agent": "SnowMoon-Autonomous-Agent/1.0" },
      });
      if (!resp.ok) {
        return {
          ok: false,
          output: `NEAR docs HTTP ${resp.status}`,
          summary: `HTTP ${resp.status}`,
        };
      }
      const txt = await resp.text();
      const lines = txt.split(/\r?\n/);
      const terms = query.split(/\s+/).filter(Boolean);
      const matches = lines
        .filter((l) => terms.some((t) => l.toLowerCase().includes(t)))
        .slice(0, 30);
      return {
        ok: true,
        output: matches.length > 0 ? matches.join("\n") : txt.slice(0, 4000),
        summary: `${matches.length} NEAR doc links`,
      };
    }

    if (toolName === "discover_near_market_agents") {
      const query = String(rawArgs.query || "").trim();
      const category = typeof rawArgs.category === "string" ? rawArgs.category.trim() : undefined;
      const maxPriceUsdc =
        typeof rawArgs.max_price_usdc === "number" && Number.isFinite(rawArgs.max_price_usdc)
          ? rawArgs.max_price_usdc
          : undefined;
      const agents = await discoverNearMarketAgents({
        query,
        category,
        maxPriceUsdc,
        fetchImpl: ctx.fetchImpl,
      });
      if (agents.length === 0) {
        return {
          ok: true,
          output: `No available NEAR AI Market agents matched query="${query}".`,
          summary: "0 market agents",
        };
      }
      const lines = agents.map(
        (a, i) =>
          `${i + 1}. @${a.handle} (${a.name}) — category=${a.category}, price=${a.priceUsdc ? `$${a.priceUsdc} USDC` : "402 quote"}, sla=${a.slaSeconds}s, delivered=${a.deliveredJobs}, success=${a.successRate}%\n   ${a.description}`
      );
      return {
        ok: true,
        output: `NEAR AI Agent Market candidates:\n${lines.join("\n")}`,
        summary: `${agents.length} market agents`,
      };
    }

    if (toolName === "hire_near_market_agent") {
      const handle = String(rawArgs.handle || "").trim();
      const taskPrompt = String(rawArgs.task_prompt || "").trim();
      if (!handle || !taskPrompt) {
        return {
          ok: false,
          output: "Missing required handle or task_prompt.",
          summary: "invalid args",
        };
      }
      const rawJobBudget = BigInt(ctx.jobBudgetAtomic || "0");
      const jobBudget = rawJobBudget > 0n ? rawJobBudget : 100_000n; // default $0.10 cap if unset or "0"
      const defaultPerHireCap = jobBudget < 250_000n ? jobBudget : 250_000n; // Least-cost cap: max $0.25 unless explicitly raised
      const requestedMaxAtomic =
        typeof rawArgs.max_budget_usdc === "number" && Number.isFinite(rawArgs.max_budget_usdc) && rawArgs.max_budget_usdc > 0
          ? BigInt(Math.round(rawArgs.max_budget_usdc * 1_000_000))
          : defaultPerHireCap;
      const effectiveMaxAtomic = (requestedMaxAtomic < jobBudget ? requestedMaxAtomic : jobBudget).toString();
      const fallbackHandles = Array.isArray(rawArgs.fallback_handles)
        ? rawArgs.fallback_handles.map((x) => String(x).trim()).filter(Boolean)
        : undefined;
      const fallbackQuery =
        typeof rawArgs.fallback_query === "string" ? rawArgs.fallback_query.trim() : undefined;
      const payerAccountId = (ctx.nearAccountId || process.env.NEAR_ACCOUNT_ID || "").trim();
      const payerPrivateKey = (ctx.nearPrivateKey || process.env.NEAR_PRIVATE_KEY || "").trim();

      const failoverRes = await hireBestMarketAgentWithFailover({
        primaryHandle: handle,
        fallbackHandles,
        query: fallbackQuery,
        prompt: taskPrompt,
        jobId: ctx.jobId || "0x" + "00".repeat(32),
        maxBudgetAtomic: effectiveMaxAtomic,
        payerAccountId,
        payerPrivateKey,
        nearRpcUrl: ctx.nearRpcUrl,
        fetchImpl: ctx.fetchImpl,
        policyEngine: ctx.spendingPolicy,
        delegateSigner: ctx.x402DelegateSigner,
        onTrace: ctx.onTrace,
      });

      if (failoverRes.ok && failoverRes.result) {
        const res = failoverRes.result;
        return {
          ok: true,
          output: `NEAR AI Market Hire Completed (@${res.handle}, task=${res.taskId}, paid=$${res.paidAmountUsdc} USDC via x402):\n\n${res.outputText}${res.artifactUrls.length ? `\n\nArtifacts:\n${res.artifactUrls.join("\n")}` : ""}`,
          summary: `x402 hired @${res.handle} ($${res.paidAmountUsdc})`,
        };
      }

      return {
        ok: false,
        output: `MARKETPLACE_FALLBACK_TO_NATIVE_AI: ${failoverRes.error || "Marketplace agent unavailable."}\nDo NOT retry marketplace hires or fail the job. Immediately complete the full task using SnowMoon's native NEAR AI Cloud + github_* + near_rpc_view tools and deliver the complete report.`,
        summary: `marketplace failover -> native AI`,
      };
    }

    return {
      ok: false,
      output: `Unknown tool: ${toolName}`,
      summary: "unknown tool",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: `Tool error: ${msg}`, summary: "error" };
  }
}

