import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { createSnowMoonApp } from "../src/server.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "snowmoon-phase20-"));
}

test("42. Phase 20.1 Production route policy: allowlist, denylist, FloatPool/Vault prep & operator approval auth", async () => {
  const dir = makeTempDir();
  const prodConfig = loadConfig({
    SNOWMOON_PORT: "0",
    SNOWMOON_NETWORK: "mainnet",
    SNOWMOON_CHAIN_MODE: "rpc",
    WALLET_SESSION_SECRET: "test-phase20-secret",
    SNOWMOON_STATE_FILE: path.join(dir, "state.json"),
    SNOWMOON_PERSISTENCE_FILE: path.join(dir, "db.json"),
  });
  const app = createSnowMoonApp(prodConfig);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));

  try {
    const addr = app.server.address();
    assert(addr && typeof addr === "object");
    const base = `http://127.0.0.1:${addr.port}`;

    // 1. /api/routes/policy exposes explicit allowlist and denylist
    const policyRes = await fetch(`${base}/api/routes/policy`);
    assert.equal(policyRes.status, 200);
    const policyJson = (await policyRes.json()) as {
      ok: boolean;
      isProductionMode: boolean;
      allowSandboxDemoEndpoints: boolean;
      policy: {
        sandboxOnlyBlockedInProduction: string[];
        productionAllowedRoutes: { walletSessionAuthenticated: string[] };
      };
    };
    assert.equal(policyJson.ok, true);
    assert.equal(policyJson.isProductionMode, true);
    assert.equal(policyJson.allowSandboxDemoEndpoints, false);
    assert.ok(policyJson.policy.sandboxOnlyBlockedInProduction.includes("/api/reset"));
    assert.ok(
      policyJson.policy.productionAllowedRoutes.walletSessionAuthenticated.includes(
        "/api/near/float/prepare-deposit"
      )
    );

    // 2. /api/approvals/decide is NOT blocked by sandbox gate in production, and enforces operator wallet session
    const unauthApproval = await fetch(`${base}/api/approvals/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId: "missing", decidedBy: "cryptozax.near" }),
    });
    assert.notEqual(unauthApproval.status, 403);
    const unauthAppJson = (await unauthApproval.json()) as { error?: string };
    assert.match(unauthAppJson.error || "", /ERR_WALLET_AUTH_REQUIRED/);

    // 3. Connect wallet sessions for LP/Customer and Operator
    const lpToken = app.walletSessionManager.issueToken({
      connected: true,
      accountId: "lp1.near",
      walletType: "meteor",
      networkId: "mainnet",
      verifiedAt: new Date().toISOString(),
    });
    const custToken = app.walletSessionManager.issueToken({
      connected: true,
      accountId: "alice.near",
      walletType: "meteor",
      networkId: "mainnet",
      verifiedAt: new Date().toISOString(),
    });

    // 4. Production FloatPool deposit & withdraw prepare routes work with wallet session & match Rust ABI
    const unauthFloat = await fetch(`${base}/api/near/float/prepare-deposit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lpAccountId: "lp1.near", amountUsdcAtomic: "25000000" }),
    });
    assert.equal(unauthFloat.ok, false);

    const depRes = await fetch(`${base}/api/near/float/prepare-deposit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-session": lpToken,
      },
      body: JSON.stringify({ lpAccountId: "lp1.near", amountUsdcAtomic: "25000000" }),
    });
    assert.equal(depRes.status, 200);
    const depJson = (await depRes.json()) as {
      ok: boolean;
      transaction: {
        signerId: string;
        receiverId: string;
        actions: Array<{ methodName: string; args: { receiver_id: string; amount: string; msg: string } }>;
      };
    };
    assert.equal(depJson.ok, true);
    assert.equal(depJson.transaction.signerId, "lp1.near");
    assert.equal(depJson.transaction.receiverId, prodConfig.mainnetUsdcContractId);
    assert.equal(depJson.transaction.actions[0].methodName, "ft_transfer_call");
    assert.equal(depJson.transaction.actions[0].args.receiver_id, "core.cryptozax.near");
    assert.equal(depJson.transaction.actions[0].args.amount, "25000000");
    assert.deepEqual(JSON.parse(depJson.transaction.actions[0].args.msg), {
      DepositPool: { receiver: null },
    });

    const wdrRes = await fetch(`${base}/api/near/float/prepare-withdraw`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-session": lpToken,
      },
      body: JSON.stringify({ lpAccountId: "lp1.near", amountUsdcAtomic: "10000000" }),
    });
    assert.equal(wdrRes.status, 200);
    const wdrJson = (await wdrRes.json()) as {
      ok: boolean;
      transaction: {
        receiverId: string;
        actions: Array<{ methodName: string; args: { assets: string; receiver: string | null } }>;
      };
    };
    assert.equal(wdrJson.transaction.receiverId, "core.cryptozax.near");
    assert.equal(wdrJson.transaction.actions[0].methodName, "withdraw");
    assert.equal(wdrJson.transaction.actions[0].args.assets, "10000000");

    // 5. Production Vault accept_delivery & refund prepare routes work with customer wallet session
    const jobId = "0x" + "ab".repeat(32);
    const accRes = await fetch(`${base}/api/near/vault/prepare-accept-delivery`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-session": custToken,
      },
      body: JSON.stringify({ customerAccountId: "alice.near", jobId }),
    });
    assert.equal(accRes.status, 200);
    const accJson = (await accRes.json()) as {
      transaction: { receiverId: string; actions: Array<{ methodName: string; args: { job_id: string } }> };
    };
    assert.equal(accJson.transaction.receiverId, "core.cryptozax.near");
    assert.equal(accJson.transaction.actions[0].methodName, "accept_delivery");
    assert.equal(accJson.transaction.actions[0].args.job_id, jobId);

    const refRes = await fetch(`${base}/api/near/vault/prepare-refund`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-session": custToken,
      },
      body: JSON.stringify({ customerAccountId: "alice.near", jobId }),
    });
    assert.equal(refRes.status, 200);
    const refJson = (await refRes.json()) as {
      transaction: { receiverId: string; actions: Array<{ methodName: string; args: { job_id: string } }> };
    };
    assert.equal(refJson.transaction.actions[0].methodName, "refund");
    assert.equal(refJson.transaction.actions[0].args.job_id, jobId);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
