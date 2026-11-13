import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { NearMainnetRpcAdapter } from "../src/near_rpc.ts";
import { createSnowMoonApp } from "../src/server.ts";
import {
  MainnetEscrowTracker,
  prepareCustomerStorageRegistration,
  verifyMainnetWalletSession,
} from "../src/mainnet_escrow.ts";

class MockNearRpcAdapter extends NearMainnetRpcAdapter {
  public mockUsdcRegistered = false;
  public mockCoreCreditYocto = "0";
  public mockCoreRegYocto = "0";
  public mockVaultPaused = false;
  public mockPoolPaused = true;
  public mockMaxJobPayment = "10000000";
  public mockTxStatus: {
    ok: boolean;
    error?: string;
    result?: {
      final_execution_status?: string;
      status?: Record<string, unknown>;
      receipts_outcome?: Array<{ id?: string; outcome?: { logs?: string[]; status?: Record<string, unknown> } }>;
    };
  } = { ok: false, error: "NOT_SET" };
  public mockCoreJob: Record<string, unknown> | null = null;

  public override async inspectMainnetAccount(accountId: string) {
    return {
      accountId,
      exists: true,
      amountYocto: "5000000000000000000000000",
      amountNear: "5.0000",
      lockedYocto: "0",
      storageUsageBytes: 200,
      codeHash: "11111111111111111111111111111111",
      hasContractDeployed: false,
      usdcBalanceAtomic: "25000000",
      usdcBalanceFormatted: "$25.00 USDC",
      usdcStorageRegistered: this.mockUsdcRegistered,
      usdcStorageBalance: this.mockUsdcRegistered
        ? { total: "1250000000000000000000", available: "0" }
        : null,
    };
  }

  public override async queryCoreStorageCredit() {
    return {
      balance: { ok: true, data: this.mockCoreCreditYocto },
      registration: { ok: true, data: this.mockCoreRegYocto },
    };
  }

  public override async probeCoreContract(coreContractId = "core.cryptozax.near") {
    return {
      contractId: coreContractId,
      accountExists: true,
      hasContractCode: true,
      codeHash: "4yiQZbyTyJcwsGQcNfcNyAjeZ6EvBtmM2hgyrCKsg2gt",
      deploymentStatus: "DEPLOYED_AND_INITIALIZED" as const,
      admin: "cryptozax.near",
      jobStorageDepositYocto: "23000000000000000000000",
      viewQueryResult: {
        vault_paused: this.mockVaultPaused,
        pool_paused: this.mockPoolPaused,
        next_job_seq: 1,
      },
    };
  }

  public override async callViewMethod<T>(_contractId: string, methodName: string) {
    if (methodName === "max_job_payment") {
      return { ok: true, data: this.mockMaxJobPayment as unknown as T };
    }
    return { ok: false, error: "Unsupported mock view" };
  }

  public override async queryTransactionStatus() {
    return this.mockTxStatus;
  }

  public override async queryCoreJob() {
    if (!this.mockCoreJob) {
      return { ok: true, data: null };
    }
    return { ok: true, data: this.mockCoreJob };
  }
}

test("8. Customer wallet connection verifies Mainnet, supports Meteor/MyNearWallet/Selector, and forbids private keys", () => {
  const meteor = verifyMainnetWalletSession({
    accountId: "alice.near",
    networkId: "mainnet",
    walletType: "meteor",
  });
  assert.equal(meteor.connected, true);
  assert.equal(meteor.networkId, "mainnet");
  assert.equal(meteor.walletType, "meteor");

  const mynear = verifyMainnetWalletSession({
    accountId: "alice.near",
    networkId: "mainnet",
    walletType: "mynearwallet",
  });
  assert.equal(mynear.walletType, "mynearwallet");

  assert.throws(
    () =>
      verifyMainnetWalletSession({
        accountId: "alice.testnet",
        networkId: "testnet",
        walletType: "meteor",
      }),
    /ERR_WRONG_NETWORK/
  );

  assert.throws(
    () =>
      verifyMainnetWalletSession({
        accountId: "alice.near",
        networkId: "mainnet",
        walletType: "meteor",
        privateKey: "ed25519:secret",
      }),
    /ERR_PRIVATE_KEY_FORBIDDEN/
  );
});

test("9. Customer storage registration prepares exact missing deposits and prevents duplicate registration/deposits", async () => {
  const config = loadConfig({ SNOWMOON_MAINNET_CORE_CONTRACT_ID: "core.cryptozax.near" });
  const rpc = new MockNearRpcAdapter(config);

  // Case A: Neither USDC nor Core registered -> prepares both (0.00125 + 0.030 NEAR)
  const planA = await prepareCustomerStorageRegistration(rpc, config, "alice.near");
  assert.equal(planA.alreadySatisfied, false);
  assert.equal(planA.transactions.length, 2);
  assert.equal(planA.usdcDepositYocto, "1250000000000000000000");
  assert.equal(planA.coreDepositYocto, "30000000000000000000000");

  // Case B: USDC registered, Core registered with 0.010 NEAR credit -> prepares only 0.013 NEAR shortfall
  rpc.mockUsdcRegistered = true;
  rpc.mockCoreRegYocto = "7000000000000000000000";
  rpc.mockCoreCreditYocto = "10000000000000000000000";
  const planB = await prepareCustomerStorageRegistration(rpc, config, "alice.near");
  assert.equal(planB.alreadySatisfied, false);
  assert.equal(planB.transactions.length, 1);
  assert.equal(planB.transactions[0].receiverId, "core.cryptozax.near");
  assert.equal(planB.coreDepositYocto, "13000000000000000000000");

  // Case C: Both satisfied -> 0 transactions (no duplicate deposit)
  rpc.mockCoreCreditYocto = "23000000000000000000000";
  const planC = await prepareCustomerStorageRegistration(rpc, config, "alice.near");
  assert.equal(planC.alreadySatisfied, true);
  assert.equal(planC.transactions.length, 0);
});

test("10. NEP-141 ft_transfer_call payload matches CreateAndFundJob schema and enforces vault_paused & max_job_payment", async () => {
  const config = loadConfig({ SNOWMOON_MAINNET_CORE_CONTRACT_ID: "core.cryptozax.near" });
  const rpc = new MockNearRpcAdapter(config);
  rpc.mockUsdcRegistered = true;
  rpc.mockCoreRegYocto = "7000000000000000000000";
  rpc.mockCoreCreditYocto = "23000000000000000000000";
  rpc.mockVaultPaused = true;

  const tracker = new MainnetEscrowTracker();

  // Vault paused blocks live broadcast while still allowing payload inspection
  const pausedRes = await tracker.prepareFundJob(rpc, config, {
    customerAccountId: "alice.near",
    operatorAccountId: "cryptozax.near",
    customerPaymentUsdcAtomic: "5000000", // $5.00 USDC
    maxOperatingBudgetUsdcAtomic: "1000000",
    termsHash: "0x" + "ab".repeat(32),
    deadlineSec: 1800000000,
    clientNonce: "n1",
  });
  assert.equal(pausedRes.canBroadcastNow, false);
  assert.match(pausedRes.blockedReason || "", /ERR_VAULT_PAUSED/);
  assert.equal(pausedRes.record.preparedTransactions.length, 1);
  const ftCall = pausedRes.record.preparedTransactions[0];
  assert.equal(ftCall.receiverId, config.mainnetUsdcContractId);
  assert.equal(ftCall.actions[0].methodName, "ft_transfer_call");
  assert.equal(ftCall.actions[0].args.receiver_id, "core.cryptozax.near");
  assert.equal(ftCall.actions[0].args.amount, "5000000");
  assert.equal(ftCall.actions[0].gas, "100000000000000");
  assert.equal(ftCall.actions[0].depositYocto, "1");
  const parsedMsg = JSON.parse(String(ftCall.actions[0].args.msg));
  assert.deepEqual(parsedMsg, {
    CreateAndFundJob: {
      operator: "cryptozax.near",
      max_operating_budget: "1000000",
      terms_hash: "0x" + "ab".repeat(32),
      deadline: 1800000000,
    },
  });

  // Exceeding max_job_payment ($10.00) is rejected
  await assert.rejects(
    () =>
      tracker.prepareFundJob(rpc, config, {
        customerAccountId: "alice.near",
        customerPaymentUsdcAtomic: "15000000",
        maxOperatingBudgetUsdcAtomic: "0",
        termsHash: "0x" + "cd".repeat(32),
        deadlineSec: 1800000000,
      }),
    /ERR_EXCEEDS_MAX_JOB_PAYMENT/
  );
});

test("11. Transaction reliability handles unknown, pending, failed, final confirmation, and blocks replay/blind retry", async () => {
  const config = loadConfig({ SNOWMOON_MAINNET_CORE_CONTRACT_ID: "core.cryptozax.near" });
  const rpc = new MockNearRpcAdapter(config);
  rpc.mockUsdcRegistered = true;
  rpc.mockCoreRegYocto = "7000000000000000000000";
  rpc.mockCoreCreditYocto = "23000000000000000000000";
  rpc.mockVaultPaused = false;

  const tracker = new MainnetEscrowTracker();
  const prep1 = await tracker.prepareFundJob(rpc, config, {
    customerAccountId: "alice.near",
    operatorAccountId: "cryptozax.near",
    customerPaymentUsdcAtomic: "2000000",
    maxOperatingBudgetUsdcAtomic: "500000",
    termsHash: "0x" + "11".repeat(32),
    deadlineSec: 1800000000,
    clientNonce: "txtest1",
  });

  // Submit txHash -> PENDING
  tracker.submitSignedTransaction({
    intentId: prep1.record.intentId,
    txHash: "TxHash1111111111111111111111111111111111111",
    customerAccountId: "alice.near",
  });

  // Pending tx blocks submitting a different txHash
  assert.throws(
    () =>
      tracker.submitSignedTransaction({
        intentId: prep1.record.intentId,
        txHash: "TxHash2222222222222222222222222222222222222",
        customerAccountId: "alice.near",
      }),
    /ERR_PENDING_TX_EXISTS/
  );

  // Unknown tx -> UNKNOWN_NEEDS_RECONCILIATION & blocks blind retry
  rpc.mockTxStatus = { ok: false, error: "UNKNOWN_TRANSACTION" };
  const unknownRec = await tracker.reconcileTransaction(rpc, {
    intentId: prep1.record.intentId,
    txHash: "TxHash1111111111111111111111111111111111111",
    customerAccountId: "alice.near",
  });
  assert.equal(unknownRec.escrowState, "UNKNOWN_NEEDS_RECONCILIATION");
  assert.equal(unknownRec.onChainConfirmed, false);
  assert.throws(
    () =>
      tracker.submitSignedTransaction({
        intentId: prep1.record.intentId,
        txHash: "TxHashRetry99999999999999999999999999999999",
        customerAccountId: "alice.near",
      }),
    /ERR_BLIND_RETRY_BLOCKED/
  );

  // Final tx with EVENT_JSON + core.get_job -> FINAL_CONFIRMED
  const jobHex = "0x" + "99".repeat(32);
  rpc.mockTxStatus = {
    ok: true,
    result: {
      final_execution_status: "FINAL",
      status: { SuccessValue: "" },
      receipts_outcome: [
        {
          id: "rcpt1",
          outcome: {
            logs: [
              `EVENT_JSON:${JSON.stringify({
                standard: "snapfall",
                version: "1.0.0",
                event: "JobFunded",
                data: [{ jobId: jobHex, amount: "2000000" }],
              })}`,
            ],
            status: { SuccessValue: "" },
          },
        },
      ],
    },
  };
  rpc.mockCoreJob = {
    job_id: jobHex,
    customer: "alice.near",
    status: "Funded",
    customer_payment: "2000000",
  };

  const finalRec = await tracker.reconcileTransaction(rpc, {
    intentId: prep1.record.intentId,
    txHash: "TxHash1111111111111111111111111111111111111",
    customerAccountId: "alice.near",
  });
  assert.equal(finalRec.escrowState, "FINAL_CONFIRMED");
  assert.equal(finalRec.onChainConfirmed, true);
  assert.equal(finalRec.jobId, jobHex);

  // Replay of same txHash on a second intent is rejected
  const prep2 = await tracker.prepareFundJob(rpc, config, {
    customerAccountId: "alice.near",
    operatorAccountId: "cryptozax.near",
    customerPaymentUsdcAtomic: "3000000",
    maxOperatingBudgetUsdcAtomic: "500000",
    termsHash: "0x" + "22".repeat(32),
    deadlineSec: 1800000000,
    clientNonce: "txtest2",
  });
  assert.throws(
    () =>
      tracker.submitSignedTransaction({
        intentId: prep2.record.intentId,
        txHash: "TxHash1111111111111111111111111111111111111",
        customerAccountId: "alice.near",
      }),
    /ERR_REPLAY_DETECTED/
  );
});

test("12. Balance pre-checks reject insufficient USDC/NEAR, and reconciliation rejects failed receipts and tx signer/receiver mismatches", async () => {
  const config = loadConfig({ SNOWMOON_MAINNET_CORE_CONTRACT_ID: "core.cryptozax.near" });
  const rpc = new MockNearRpcAdapter(config);
  rpc.mockUsdcRegistered = true;
  rpc.mockCoreRegYocto = "7000000000000000000000";
  rpc.mockCoreCreditYocto = "23000000000000000000000";
  rpc.mockVaultPaused = false;

  const tracker = new MainnetEscrowTracker();

  // Insufficient USDC ($50 > $25 mock balance) - override via subclass
  class LowBalanceRpc extends MockNearRpcAdapter {
    public override async inspectMainnetAccount(accountId: string) {
      const base = await super.inspectMainnetAccount(accountId);
      return {
        ...base,
        amountYocto: "10000000000000000000000", // 0.01 NEAR (< 0.05 NEAR buffer)
        usdcBalanceAtomic: "1000000", // $1.00 USDC
      };
    }
  }
  const lowRpc = new LowBalanceRpc(config);
  lowRpc.mockUsdcRegistered = true;
  lowRpc.mockCoreRegYocto = "7000000000000000000000";
  lowRpc.mockCoreCreditYocto = "23000000000000000000000";

  await assert.rejects(
    () =>
      tracker.prepareFundJob(lowRpc, config, {
        customerAccountId: "alice.near",
        customerPaymentUsdcAtomic: "2000000",
        maxOperatingBudgetUsdcAtomic: "0",
        termsHash: "0x" + "33".repeat(32),
        deadlineSec: 1800000000,
      }),
    /ERR_INSUFFICIENT_USDC_BALANCE/
  );

  await assert.rejects(
    () =>
      tracker.prepareFundJob(lowRpc, config, {
        customerAccountId: "alice.near",
        customerPaymentUsdcAtomic: "500000",
        maxOperatingBudgetUsdcAtomic: "0",
        termsHash: "0x" + "44".repeat(32),
        deadlineSec: 1800000000,
      }),
    /ERR_INSUFFICIENT_NEAR_BALANCE/
  );

  // Failed receipt on-chain must mark FAILED, not FINAL_CONFIRMED
  const prep = await tracker.prepareFundJob(rpc, config, {
    customerAccountId: "alice.near",
    operatorAccountId: "cryptozax.near",
    customerPaymentUsdcAtomic: "2000000",
    maxOperatingBudgetUsdcAtomic: "0",
    termsHash: "0x" + "55".repeat(32),
    deadlineSec: 1800000000,
  });
  const validHash = "5bB2Rqh99bUJ8Wb13ecaXmB2ar6YTsJwvRafa784eRiD";
  tracker.submitSignedTransaction({
    intentId: prep.record.intentId,
    txHash: validHash,
    customerAccountId: "alice.near",
  });

  rpc.mockTxStatus = {
    ok: true,
    result: {
      final_execution_status: "FINAL",
      status: { Failure: { ActionError: { kind: "FunctionCallError" } } },
      receipts_outcome: [],
    },
  };
  const failedRec = await tracker.reconcileTransaction(rpc, {
    intentId: prep.record.intentId,
    txHash: validHash,
    customerAccountId: "alice.near",
  });
  assert.equal(failedRec.escrowState, "FAILED");
  assert.equal(failedRec.onChainConfirmed, false);
});

test("13. HTTP API enforces wallet session auth, anti-impersonation, 64KB body limit, secret redaction, and invalid txHash rejection", async () => {
  const app = createSnowMoonApp(
    loadConfig({
      SNOWMOON_MAINNET_CORE_CONTRACT_ID: "core.cryptozax.near",
      NEAR_MAINNET_RPC_URL: "https://rpc.mainnet.near.org",
    })
  );
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Missing x-wallet-session -> 401
    const unauthRes = await fetch(`${baseUrl}/api/near/prepare-registration`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerAccountId: "cryptozax.near" }),
    });
    assert.equal(unauthRes.status, 401);
    const unauthJson = (await unauthRes.json()) as { error: string };
    assert.match(unauthJson.error, /ERR_WALLET_AUTH_REQUIRED/);

    // 2. Verify wallet session on live read-only Mainnet RPC (cryptozax.near)
    const verifyRes = await fetch(`${baseUrl}/api/near/wallet/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "cryptozax.near",
        networkId: "mainnet",
        walletType: "meteor",
      }),
    });
    assert.equal(verifyRes.status, 200);
    const verifyJson = (await verifyRes.json()) as {
      ok: boolean;
      walletSessionToken: string;
      customerState: { vaultPaused: boolean; poolPaused: boolean };
    };
    assert.equal(verifyJson.ok, true);
    assert.ok(verifyJson.walletSessionToken.includes("."));
    assert.equal(verifyJson.customerState.vaultPaused, true);
    assert.equal(verifyJson.customerState.poolPaused, true);

    // 3. Impersonation blocked -> 403
    const impRes = await fetch(`${baseUrl}/api/near/prepare-registration`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-session": verifyJson.walletSessionToken,
      },
      body: JSON.stringify({ customerAccountId: "alice.near" }),
    });
    assert.equal(impRes.status, 403);
    const impJson = (await impRes.json()) as { error: string };
    assert.match(impJson.error, /ERR_ACCOUNT_IMPERSONATION_BLOCKED/);

    // 4. Oversized payload (> 64 KB) -> 413
    const bigRes = await fetch(`${baseUrl}/api/near/prepare-registration`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(70_000) }),
    });
    assert.equal(bigRes.status, 413);

    // 5. Invalid txHash format rejected -> 400
    const badTxRes = await fetch(`${baseUrl}/api/near/escrow/submit-tx`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-session": verifyJson.walletSessionToken,
      },
      body: JSON.stringify({
        intentId: "abc",
        txHash: "not-a-valid-hash!!",
        customerAccountId: "cryptozax.near",
      }),
    });
    assert.equal(badTxRes.status, 400);
    const badTxJson = (await badTxRes.json()) as { error: string };
    assert.match(badTxJson.error, /ERR_INVALID_TX_HASH/);

    // 6. Secret redaction in error responses
    const secretErrRes = await fetch(`${baseUrl}/api/near/wallet/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "ed25519:3XyZFakeSecretKeyMaterialThatShouldNeverLeak123456",
        networkId: "mainnet",
        walletType: "meteor",
      }),
    });
    assert.equal(secretErrRes.status, 400);
    const secretErrText = await secretErrRes.text();
    assert.ok(!secretErrText.includes("3XyZFakeSecretKeyMaterial"));
    assert.ok(secretErrText.includes("[REDACTED]"));
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

