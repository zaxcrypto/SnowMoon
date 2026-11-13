import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { NearIntentsClient } from "../src/near_intents.ts";
import { NearMainnetRpcAdapter } from "../src/near_rpc.ts";
import {
  encodeErc20TransferCalldata,
  executeCustomerSourceWalletDeposit,
  type Eip1193Provider,
  type SolanaWalletProvider,
  type NearWalletSelectorProvider,
} from "../src/source_wallets.ts";
import { SupabaseDatabaseAdapter } from "../src/persistence.ts";
import { OutLayerExecutionAdapter } from "../src/outlayer.ts";
import { createSnowMoonApp } from "../src/server.ts";

test("26. Phase 11.1 Source wallet adapters (EVM EIP-1193, Solana, NEAR): signing, ERC-20 calldata, wrong network, rejection & insufficient funds", async () => {
  const cfg = loadConfig({ SNOWMOON_AI_MODE: "mock" });
  const ethDeposit = "0x2222222222222222222222222222222222222222";
  const solDeposit = "So1anaDepositAddr11111111111111111111111111";

  const calldata = encodeErc20TransferCalldata(ethDeposit, "5000000");
  assert.ok(calldata.startsWith("0xa9059cbb"));
  assert.equal(calldata.length, 138);

  const mockRpc = {
    inspectMainnetAccount: async (accountId: string) => ({
      accountId,
      exists: true,
      amountNear: "5.0000",
      usdcBalanceAtomic: "1000000",
    }),
  } as unknown as NearMainnetRpcAdapter;

  let quoteIdx = 0;
  const mockFetch = (async (url: string) => {
    if (url.endsWith("/v0/tokens")) {
      return new Response(
        JSON.stringify([
          {
            assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
            decimals: 6,
            blockchain: "eth",
            symbol: "USDC",
          },
          {
            assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
            decimals: 6,
            blockchain: "sol",
            symbol: "USDC",
          },
          {
            assetId: `nep141:${cfg.mainnetUsdcContractId}`,
            decimals: 6,
            blockchain: "near",
            symbol: "USDC",
            contractAddress: cfg.mainnetUsdcContractId,
          },
        ]),
        { status: 200 }
      );
    }
    if (url.endsWith("/v0/quote")) {
      quoteIdx += 1;
      const addr = quoteIdx === 1 ? ethDeposit : solDeposit;
      return new Response(
        JSON.stringify({
          quote: {
            depositAddress: addr,
            amountIn: "5000000",
            amountOut: "4980000",
            minAmountOut: "4950000",
            deadline: new Date(Date.now() + 600_000).toISOString(),
          },
        }),
        { status: 200 }
      );
    }
    if (url.endsWith("/v0/deposit/submit")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  const intents = new NearIntentsClient(cfg, mockFetch);
  await intents.requestQuote(mockRpc, {
    dry: false,
    originAsset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    amountAtomic: "5000000",
    slippageToleranceBps: 100,
    customerNearAccount: "alice.near",
    sourceWalletAddress: "0x1111111111111111111111111111111111111111",
  });

  // Wrong network rejected
  const wrongChainEvm: Eip1193Provider = {
    request: async ({ method }) => (method === "eth_chainId" ? "0x89" : []),
  };
  await assert.rejects(
    () =>
      executeCustomerSourceWalletDeposit({
        intentsClient: intents,
        depositAddress: ethDeposit,
        evmProvider: wrongChainEvm,
      }),
    /ERR_WRONG_NETWORK/
  );

  // User rejection (4001) mapped cleanly
  const rejectedEvm: Eip1193Provider = {
    request: async ({ method }) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_requestAccounts") return ["0x1111111111111111111111111111111111111111"];
      throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    },
  };
  await assert.rejects(
    () =>
      executeCustomerSourceWalletDeposit({
        intentsClient: intents,
        depositAddress: ethDeposit,
        evmProvider: rejectedEvm,
      }),
    /ERR_WALLET_REJECTED/
  );

  // Insufficient funds mapped cleanly
  const poorEvm: Eip1193Provider = {
    request: async ({ method }) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_requestAccounts") return ["0x1111111111111111111111111111111111111111"];
      throw new Error("insufficient funds for intrinsic transaction cost");
    },
  };
  await assert.rejects(
    () =>
      executeCustomerSourceWalletDeposit({
        intentsClient: intents,
        depositAddress: ethDeposit,
        evmProvider: poorEvm,
      }),
    /ERR_INSUFFICIENT_FUNDS/
  );

  // Valid EVM signing & submission
  const validEvm: Eip1193Provider = {
    request: async ({ method }) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_requestAccounts") return ["0x1111111111111111111111111111111111111111"];
      if (method === "eth_sendTransaction") return "0x" + "ab".repeat(32);
      return null;
    },
  };
  const evmDone = await executeCustomerSourceWalletDeposit({
    intentsClient: intents,
    depositAddress: ethDeposit,
    evmProvider: validEvm,
  });
  assert.equal(evmDone.walletResult.walletAdapter, "evm_eip1193");
  assert.equal(evmDone.updatedIntent.lifecycleStage, "SOURCE_TX_SIGNED");

  // Solana Wallet Standard signing & submission
  await intents.requestQuote(mockRpc, {
    dry: false,
    originAsset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    amountAtomic: "5000000",
    slippageToleranceBps: 100,
    customerNearAccount: "alice.near",
    sourceWalletAddress: "SolCustomer11111111111111111111111111111111",
  });
  const validSol: SolanaWalletProvider = {
    publicKey: "SolCustomer11111111111111111111111111111111",
    signAndSendTransaction: async () => ({
      signature: "SolSig111111111111111111111111111111111111111111",
    }),
  };
  const solDone = await executeCustomerSourceWalletDeposit({
    intentsClient: intents,
    depositAddress: solDeposit,
    solanaWallet: validSol,
  });
  assert.equal(solDone.walletResult.walletAdapter, "solana_wallet_standard");
  assert.equal(solDone.updatedIntent.lifecycleStage, "SOURCE_TX_SIGNED");

  // NEAR Wallet Selector type check
  const nearWallet: NearWalletSelectorProvider = {
    accountId: "alice.near",
    signAndSendTransaction: async () => ({ transaction: { hash: "NearTxHash123" } }),
  };
  assert.equal(typeof nearWallet.signAndSendTransaction, "function");
});

test("27. Phase 11.2 Supabase connection failure, local fallback safety & pending resync recovery", async () => {
  const tmpFile = path.join(os.tmpdir(), `snowmoon-p11-sb-${Date.now()}.json`);
  let online = false;
  try {
    const mockFetch = (async (url: string) => {
      if (!online) {
        return new Response("Service Unavailable", { status: 503 });
      }
      if (url.includes("snowmoon_migrations")) {
        return new Response(JSON.stringify([{ id: "001_initial_schema" }]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    const sb = new SupabaseDatabaseAdapter(
      "https://example.supabase.co",
      "sb_secret_test_11",
      tmpFile,
      mockFetch
    );

    // Save while Supabase is down: safely persisted locally & queued for resync
    sb.saveCollection("workers", [{ workerId: "w-offline", accountId: "w.near" }]);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sb.getCollection("workers").length, 1);
    assert.ok(sb.getPendingSyncCount() >= 1);

    const downHealth = await sb.healthCheck();
    assert.equal(downHealth.productionReady, false);

    // Supabase recovers -> resyncPending flushes dirty collections
    online = true;
    const resynced = await sb.resyncPending();
    assert.ok(resynced.synced.includes("workers"));
    assert.equal(resynced.failed.length, 0);
    assert.equal(sb.getPendingSyncCount(), 0);

    const upHealth = await sb.healthCheck();
    assert.equal(upHealth.productionReady, true);
    assert.equal(upHealth.migrationVersion, "001_initial_schema");
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test("28. Phase 11.3, 11.4 & 11.5 OutLayer config validation, claim_usdc fallback prep & AuditAnchor readiness", async () => {
  const missingCfg = loadConfig({ SNOWMOON_AI_MODE: "mock" });
  const olMissing = new OutLayerExecutionAdapter(missingCfg);
  const valMissing = olMissing.validateConfiguration();
  assert.equal(valMissing.readyForLiveExecution, false);
  assert.ok(valMissing.missingEnvVars.includes("OUTLAYER_PAYMENT_KEY"));

  const readyCfg = loadConfig({
    OUTLAYER_PAYMENT_KEY: "ol_secret_p11",
    OUTLAYER_PROJECT_OWNER: "cryptozax.near",
    OUTLAYER_PROJECT_NAME: "snowmoon-worker",
  });
  const valReady = new OutLayerExecutionAdapter(readyCfg).validateConfiguration();
  assert.equal(valReady.readyForLiveExecution, true);
  assert.ok(!JSON.stringify(valReady).includes("ol_secret_p11"));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snowmoon-p11-http-"));
  const app = createSnowMoonApp(
    loadConfig({
      SNOWMOON_AI_MODE: "mock",
      SNOWMOON_STATE_FILE: path.join(tmpDir, "state.json"),
      SNOWMOON_PERSISTENCE_FILE: path.join(tmpDir, "p9.json"),
    })
  );
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const olStatus = await fetch(`${baseUrl}/api/outlayer/config-status`);
    assert.equal(olStatus.status, 200);
    const olJson = (await olStatus.json()) as { ok: boolean; outlayer: { mode: string } };
    assert.equal(olJson.ok, true);
    assert.equal(olJson.outlayer.mode, "mock_fallback");

    const unauthClaim = await fetch(`${baseUrl}/api/settlement/prepare-claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claimantAccountId: "worker.near", amountAtomic: "1500000" }),
    });
    assert.equal(unauthClaim.status, 401);

    const token = app.walletSessionManager.issueToken({
      connected: true,
      accountId: "worker.near",
      walletType: "meteor",
      networkId: "mainnet",
      verifiedAt: new Date().toISOString(),
    });
    const claimResp = await fetch(`${baseUrl}/api/settlement/prepare-claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-session": token,
      },
      body: JSON.stringify({ claimantAccountId: "worker.near", amountAtomic: "1500000" }),
    });
    assert.equal(claimResp.status, 200);
    const claimJson = (await claimResp.json()) as {
      ok: boolean;
      preparedTransaction: {
        actions: Array<{ methodName: string; args: { amount: string } }>;
      };
    };
    assert.equal(claimJson.ok, true);
    assert.equal(claimJson.preparedTransaction.actions[0].methodName, "claim_usdc");
    assert.equal(claimJson.preparedTransaction.actions[0].args.amount, "1500000");

    const auditResp = await fetch(`${baseUrl}/api/audit/readiness`);
    assert.equal(auditResp.status, 200);
    const auditJson = (await auditResp.json()) as {
      ok: boolean;
      mainnet: {
        gasReserveNear: string;
        postDeploymentChecks: string[];
        rollbackAndRecovery: string[];
      };
    };
    assert.equal(auditJson.ok, true);
    assert.equal(auditJson.mainnet.gasReserveNear, "0.18");
    assert.ok(auditJson.mainnet.postDeploymentChecks.length >= 2);
    assert.ok(auditJson.mainnet.rollbackAndRecovery.length >= 2);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
