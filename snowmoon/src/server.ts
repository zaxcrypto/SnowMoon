import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type SnowMoonConfig } from "./config.ts";
import {
  ANCHOR_FINAL_STAKE,
  ANCHOR_STORAGE_DEPOSIT,
  JOB_STORAGE_DEPOSIT_INITIAL,
  LP_SHARE_STAKE,
  STORAGE_REGISTRATION,
  SnowMoonEngine,
} from "./engine.ts";
import { AIWorkerAdapter, OutLayerPolicyAdapter } from "./adapters.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SnowMoonApp {
  config: SnowMoonConfig;
  engine: SnowMoonEngine;
  policyAdapter: OutLayerPolicyAdapter;
  aiAdapter: AIWorkerAdapter;
  server: http.Server;
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

export function buildSystemSnapshot(
  config: SnowMoonConfig,
  engine: SnowMoonEngine,
  policyAdapter: OutLayerPolicyAdapter,
  aiAdapter: AIWorkerAdapter
) {
  const jobs = Array.from(engine.jobs.values()).sort((a, b) => b.seq - a.seq);
  const advances = Array.from(engine.advances.values()).sort(
    (a, b) => b.advanceId - a.advanceId
  );
  const approvals = Array.from(engine.approvals.values()).reverse();
  const anchors = Array.from(engine.anchors.values()).sort(
    (a, b) => b.anchoredAtSec - a.anchoredAtSec
  );

  const balances: Record<string, string> = {};
  for (const [acct, bal] of engine.usdcBalances.entries()) {
    balances[acct] = bal.toString();
  }

  const shares: Record<string, string> = {};
  for (const [acct, sh] of engine.lpShares.entries()) {
    shares[acct] = sh.toString();
  }

  const totalEscrowed = jobs
    .filter((j) => j.state === "Funded" || j.state === "InProgress" || j.state === "Delivered")
    .reduce((acc, j) => acc + BigInt(j.customerPayment), 0n);

  const totalSettledVolume = jobs
    .filter((j) => j.state === "Accepted")
    .reduce((acc, j) => acc + BigInt(j.customerPayment), 0n);

  return {
    environment: {
      network: config.network,
      chainMode: config.chainMode,
      nearRpcUrl: config.nearRpcUrl,
      coreContractId: config.coreContractId,
      auditContractId: config.auditContractId,
      usdcContractId: config.usdcContractId,
      aiMode: config.aiMode,
      aiAdapterLabel: aiAdapter.getAdapterLabel(),
      walletMode: config.walletMode,
      walletAdapterLabel: policyAdapter.getAdapterLabel(),
      autoApproveLimitUsdc: config.autoApproveLimitUsdc.toString(),
      storageConstants: {
        jobStorageDepositInitialYocto: JOB_STORAGE_DEPOSIT_INITIAL,
        storageRegistrationYocto: STORAGE_REGISTRATION,
        lpShareStakeYocto: LP_SHARE_STAKE,
        anchorStorageDepositYocto: ANCHOR_STORAGE_DEPOSIT,
        anchorFinalStakeYocto: ANCHOR_FINAL_STAKE,
      },
      accounts: {
        customer: config.customerAccountId,
        operator: config.operatorAccountId,
        lp: config.lpAccountId,
        admin: config.adminAccountId,
      },
    },
    overview: {
      totalJobs: jobs.length,
      activeJobs: jobs.filter(
        (j) =>
          j.state === "Created" ||
          j.state === "Funded" ||
          j.state === "InProgress" ||
          j.state === "Delivered"
      ).length,
      settledJobs: jobs.filter((j) => j.state === "Accepted").length,
      anchoredJobs: anchors.length,
      pendingApprovals: approvals.filter((a) => a.status === "PENDING").length,
      totalEscrowedUsdc: totalEscrowed.toString(),
      totalSettledVolumeUsdc: totalSettledVolume.toString(),
    },
    floatPool: {
      epoch: engine.epoch,
      paused: engine.paused,
      poolIdleCashUsdc: engine.poolIdleCash.toString(),
      totalOutstandingUsdc: engine.totalOutstanding.toString(),
      totalAssetsUsdc: engine.totalAssets().toString(),
      totalShares: engine.totalShares.toString(),
      lossReserveUsdc: engine.lossReserve.toString(),
      advanceAprBps: engine.advanceAprBps.toString(),
      maxUtilizationBps: engine.maxUtilizationBps.toString(),
      creditLineMultiplierBps: engine.creditLineMultiplierBps.toString(),
      lpSharesByAccount: shares,
    },
    balancesUsdc: balances,
    jobs,
    advances,
    approvals,
    anchors,
    events: engine.events.slice(0, 60),
  };
}

export function createSnowMoonApp(customConfig?: SnowMoonConfig): SnowMoonApp {
  const config = customConfig ?? loadConfig();
  const engine = new SnowMoonEngine(config);
  const policyAdapter = new OutLayerPolicyAdapter(config, engine);
  const aiAdapter = new AIWorkerAdapter(config);

  const publicDir = path.resolve(__dirname, "..", "public");

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathname = parsedUrl.pathname;

      if (method === "OPTIONS") {
        sendJson(res, 200, { ok: true });
        return;
      }

      // 1. Health & full state snapshot
      if (method === "GET" && pathname === "/api/state") {
        sendJson(
          res,
          200,
          buildSystemSnapshot(config, engine, policyAdapter, aiAdapter)
        );
        return;
      }

      // 2. Reset sandbox state
      if (method === "POST" && pathname === "/api/reset") {
        engine.seedInitialState();
        sendJson(res, 200, {
          ok: true,
          message: "Sandbox state reset to clean initial balances and $5,000 FloatPool liquidity.",
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 3. Step 2 (& optionally Step 3): Create Job
      if (method === "POST" && pathname === "/api/jobs/create") {
        const body = await readJsonBody(req);
        const creator = String(body.creator || config.customerAccountId);
        const customer = String(body.customer || config.customerAccountId);
        const operator = String(body.operator || config.operatorAccountId);
        const title = String(
          body.title || "NEAR DeFi Float & Storage Security Verification"
        );
        const taskDescription = String(
          body.taskDescription ||
            "Execute autonomous verification of NEAR protocol liquidity metrics, query market depth feeds under OutLayer spending policy, and generate a cryptographic deliverable hash for AuditAnchor."
        );
        const customerPaymentUsdc = BigInt(String(body.customerPaymentUsdc || "100000000")); // default $100.00 USDC
        const maxOperatingBudgetUsdc = BigInt(
          String(body.maxOperatingBudgetUsdc || "25000000")
        ); // default $25.00 USDC
        const fundImmediately = Boolean(body.fundImmediately ?? false);

        const job = engine.createJob({
          creator,
          customer,
          operator,
          title,
          taskDescription,
          customerPaymentUsdc,
          maxOperatingBudgetUsdc,
          termsHash: body.termsHash ? String(body.termsHash) : undefined,
          fundImmediately,
        });

        sendJson(res, 200, {
          ok: true,
          job,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 4. Step 3: Fund Job
      if (method === "POST" && pathname === "/api/jobs/fund") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const caller = String(body.caller || config.customerAccountId);
        const job = engine.fundJob(jobId, caller);
        sendJson(res, 200, {
          ok: true,
          job,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 5. Cancel unfunded Created job (verifies AUD-01 / Decision 2 Option A)
      if (method === "POST" && pathname === "/api/jobs/cancel") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const caller = String(body.caller || config.customerAccountId);
        const result = engine.cancelJob(jobId, caller);
        sendJson(res, 200, {
          ok: true,
          result,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 6. FloatPool Working Capital Advance for a funded job
      if (method === "POST" && pathname === "/api/jobs/advance") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const caller = String(body.caller || config.operatorAccountId);
        const amountUsdc = BigInt(String(body.amountUsdc || "20000000")); // default $20.00 USDC
        const advance = engine.requestAdvance(jobId, caller, amountUsdc);
        sendJson(res, 200, {
          ok: true,
          advance,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 7. Step 5: Operator / AI Daemon receives job & starts work
      if (method === "POST" && pathname === "/api/jobs/start") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const caller = String(body.caller || config.operatorAccountId);
        const job = engine.startWork(jobId, caller);
        sendJson(res, 200, {
          ok: true,
          job,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 8. Step 7: Worker requests controlled spending via OutLayer Policy Adapter
      if (method === "POST" && pathname === "/api/jobs/spend") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const caller = String(body.caller || config.operatorAccountId);
        const vendor = String(body.vendor || "Pyth / NEAR Indexer Telemetry Feed");
        const description = String(
          body.description || "Real-time orderbook & storage trie snapshot query"
        );
        const amountUsdc = BigInt(String(body.amountUsdc || "40000")); // default $0.04 USDC
        const result = policyAdapter.requestSpend({
          jobId,
          caller,
          vendor,
          description,
          amountUsdc,
        });
        sendJson(res, 200, {
          ok: true,
          result,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 9. Step 8: Human Operator decides an escalated approval request
      if (method === "POST" && pathname === "/api/approvals/decide") {
        const body = await readJsonBody(req);
        const approvalId = String(body.approvalId || "");
        const decidedBy = String(body.decidedBy || config.operatorAccountId);
        const decision =
          String(body.decision || "APPROVE").toUpperCase() === "REJECT"
            ? "REJECT"
            : "APPROVE";
        const note = body.note ? String(body.note) : undefined;
        const result = policyAdapter.decideApproval({
          approvalId,
          decidedBy,
          decision,
          note,
        });
        sendJson(res, 200, {
          ok: true,
          result,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 10. Step 6 & Step 9: AI Worker executes the task & submits result + evidence hash
      if (method === "POST" && pathname === "/api/jobs/execute-and-deliver") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const caller = String(body.caller || config.operatorAccountId);
        const job = engine.jobs.get(jobId);
        if (!job) throw new Error("ERR_JOB_NOT_FOUND");
        if (job.state === "Funded") {
          engine.startWork(jobId, caller);
        }
        const aiExecution = await aiAdapter.executeJobTask(job);
        const updatedJob = engine.submitDelivery({
          jobId,
          caller,
          deliveryHash: aiExecution.deliveryHash,
          aiExecution,
        });
        sendJson(res, 200, {
          ok: true,
          aiExecution,
          job: updatedJob,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 11. Step 10 & Step 11: Customer accepts delivery -> Settlement accounting executes
      if (method === "POST" && pathname === "/api/jobs/accept") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const caller = String(body.caller || config.customerAccountId);
        const job = engine.acceptDelivery(jobId, caller);
        sendJson(res, 200, {
          ok: true,
          job,
          settlement: job.settlement,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 12. Step 12: AuditAnchor verifies delivery state on Core & records immutable anchor
      if (method === "POST" && pathname === "/api/audit/anchor") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const caller = String(body.caller || config.customerAccountId);
        const anchor = engine.anchorJob(jobId, caller);
        sendJson(res, 200, {
          ok: true,
          anchor,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 13. FloatPool LP Deposit & Withdraw endpoints
      if (method === "POST" && pathname === "/api/float/deposit") {
        const body = await readJsonBody(req);
        const lpAccount = String(body.lpAccount || config.lpAccountId);
        const assetsUsdc = BigInt(String(body.assetsUsdc || "1000000000")); // $1,000 USDC
        const result = engine.depositPool(lpAccount, assetsUsdc);
        sendJson(res, 200, {
          ok: true,
          sharesMinted: result.shares.toString(),
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/float/withdraw") {
        const body = await readJsonBody(req);
        const lpAccount = String(body.lpAccount || config.lpAccountId);
        const assetsUsdc = BigInt(String(body.assetsUsdc || "500000000")); // $500 USDC
        const result = engine.withdrawPool(lpAccount, assetsUsdc);
        sendJson(res, 200, {
          ok: true,
          sharesBurned: result.sharesBurned.toString(),
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 14. Execute Complete 12-Step Customer-to-Settlement-to-Audit Journey in One Click
      if (method === "POST" && pathname === "/api/demo/run-complete-journey") {
        const body = await readJsonBody(req);
        const stepsLog: Array<{ step: number; title: string; detail: string }> = [];

        // Step 1: Customer connects wallet
        stepsLog.push({
          step: 1,
          title: "Customer connects wallet",
          detail: `Connected customer wallet ${config.customerAccountId} (Mode: ${config.chainMode.toUpperCase()}).`,
        });

        // Step 2: Customer creates an AI job ($100.00 USDC payment, $25.00 max operating budget)
        const job = engine.createJob({
          creator: config.customerAccountId,
          customer: config.customerAccountId,
          operator: config.operatorAccountId,
          title: String(
            body.title || "Autonomous NEAR Protocol Liquidity & Security Audit"
          ),
          taskDescription: String(
            body.taskDescription ||
              "Execute on-chain storage & FloatPool invariants analysis, pull institutional orderbook telemetry within budget, and anchor a cryptographic proof on AuditAnchor."
          ),
          customerPaymentUsdc: 100_000_000n, // $100.00 USDC
          maxOperatingBudgetUsdc: 25_000_000n, // $25.00 USDC
        });
        stepsLog.push({
          step: 2,
          title: "Customer creates an AI job",
          detail: `Contract-derived Job ID ${job.jobId} created (seq=${job.seq}, storage locked=0.023 NEAR).`,
        });

        // Step 3: Customer funds the job
        engine.fundJob(job.jobId, config.customerAccountId);
        stepsLog.push({
          step: 3,
          title: "Customer funds the job",
          detail: `$100.00 USDC escrowed in ${config.coreContractId} by ${config.customerAccountId}.`,
        });

        // Step 4: Job appears in the dashboard
        stepsLog.push({
          step: 4,
          title: "Job appears in the dashboard",
          detail: `Job ${job.jobId.slice(0, 14)}... indexed in state Funded with termsHash ${job.termsHash.slice(0, 14)}...`,
        });

        // Step 5: AI daemon receives the job (+ draws $20.00 USDC working capital advance from FloatPool)
        const adv = engine.requestAdvance(
          job.jobId,
          config.operatorAccountId,
          20_000_000n
        );
        engine.startWork(job.jobId, config.operatorAccountId);
        stepsLog.push({
          step: 5,
          title: "AI daemon receives the job & draws FloatPool advance",
          detail: `Operator ${config.operatorAccountId} started work and drew $20.00 USDC working-capital advance (#${adv.advanceId}, fee=$0.40 USDC).`,
        });

        // Step 7: Worker requests controlled spending ($0.04 auto-approved + $4.00 escalated)
        const microSpend = policyAdapter.requestSpend({
          jobId: job.jobId,
          caller: config.operatorAccountId,
          vendor: "NEAR Lake Indexer Telemetry API",
          description: "Micro-query for historical block & storage delta headers",
          amountUsdc: 40_000n, // $0.04 USDC (auto-approved <= $0.10)
        });
        const escalatedSpend = policyAdapter.requestSpend({
          jobId: job.jobId,
          caller: config.operatorAccountId,
          vendor: "Kaiko Institutional Liquidity Dataset",
          description: "Deep orderbook & USDC slippage dataset for risk verification",
          amountUsdc: 4_000_000n, // $4.00 USDC (escalated > $0.10)
        });
        stepsLog.push({
          step: 7,
          title: "Worker requests controlled spending",
          detail: `$0.04 micro-spend AUTO-APPROVED (${microSpend.expense?.receiptHash.slice(0, 14)}...); $4.00 dataset spend ESCALATED to operator queue (${escalatedSpend.approval?.approvalId}).`,
        });

        // Step 8: Approval is recorded
        const decisionRes = policyAdapter.decideApproval({
          approvalId: escalatedSpend.approval!.approvalId,
          decidedBy: config.operatorAccountId,
          decision: "APPROVE",
          note: "Verified Kaiko dataset vendor and approved $4.00 spend within $25.00 budget.",
        });
        stepsLog.push({
          step: 8,
          title: "Approval is recorded",
          detail: `Approval ${decisionRes.approval.approvalId} recorded by ${config.operatorAccountId}; total operating spend is now $4.04 USDC.`,
        });

        // Step 6 & Step 9: AI worker executes task & submits result and evidence hash
        const aiExec = await aiAdapter.executeJobTask(job);
        engine.submitDelivery({
          jobId: job.jobId,
          caller: config.operatorAccountId,
          deliveryHash: aiExec.deliveryHash,
          aiExecution: aiExec,
        });
        stepsLog.push({
          step: 6,
          title: "AI worker executes the task",
          detail: `Executed via ${aiExec.adapterLabel} in ${aiExec.durationMs}ms.`,
        });
        stepsLog.push({
          step: 9,
          title: "Worker submits the result and evidence hash",
          detail: `Submitted deliveryHash ${aiExec.deliveryHash} to ${config.coreContractId}.`,
        });

        // Step 10 & Step 11: Customer accepts delivery -> Settlement accounting executes
        const settledJob = engine.acceptDelivery(
          job.jobId,
          config.customerAccountId
        );
        stepsLog.push({
          step: 10,
          title: "Customer accepts delivery",
          detail: `Customer ${config.customerAccountId} accepted delivery for ${job.jobId.slice(0, 14)}...`,
        });
        stepsLog.push({
          step: 11,
          title: "Settlement accounting executes",
          detail: `FloatPool repaid $20.40 USDC ($20.00 principal + $0.40 yield to LPs); Operator net payout = $79.60 USDC.`,
        });

        // Step 12: AuditAnchor verifies the evidence
        const anchor = engine.anchorJob(job.jobId, config.customerAccountId);
        stepsLog.push({
          step: 12,
          title: "AuditAnchor verifies the evidence",
          detail: `Cross-contract verification succeeded on ${config.auditContractId}; immutable anchor recorded (tx=${anchor.txHash.slice(0, 16)}...).`,
        });

        stepsLog.sort((a, b) => a.step - b.step);

        sendJson(res, 200, {
          ok: true,
          jobId: settledJob.jobId,
          stepsLog,
          job: settledJob,
          anchor,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // Serve static dashboard UI from public/
      const filePath =
        pathname === "/"
          ? path.join(publicDir, "index.html")
          : path.join(publicDir, pathname.replace(/^\/+/, ""));

      if (filePath.startsWith(publicDir) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const contentType =
          ext === ".html"
            ? "text/html; charset=utf-8"
            : ext === ".js"
            ? "application/javascript; charset=utf-8"
            : ext === ".css"
            ? "text/css; charset=utf-8"
            : "application/octet-stream";
        res.writeHead(200, { "Content-Type": contentType });
        res.end(fs.readFileSync(filePath));
        return;
      }

      sendJson(res, 404, { ok: false, error: `Not found: ${method} ${pathname}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { ok: false, error: message });
    }
  });

  return { config, engine, policyAdapter, aiAdapter, server };
}

// Start HTTP server if invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const app = createSnowMoonApp();
  app.server.listen(app.config.port, app.config.host, () => {
    console.log(
      `[SnowMoon MVP] Server running at http://${app.config.host}:${app.config.port}`
    );
    console.log(
      `[SnowMoon MVP] Chain Mode: ${app.config.chainMode.toUpperCase()} (${app.config.network}) | AI Adapter: ${app.aiAdapter.getAdapterLabel()} | Wallet Policy: ${app.policyAdapter.getAdapterLabel()}`
    );
  });
}
