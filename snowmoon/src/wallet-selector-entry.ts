import { Buffer } from "buffer";
import { setupWalletSelector, type WalletSelector, type Action } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";

interface SnowMoonWalletBridge {
  init: (opts: { networkId: "mainnet" | "testnet"; contractId: string; onStateChange?: (accounts: Array<{ accountId: string; publicKey?: string }>, walletId?: string) => void }) => Promise<void>;
  openModal: () => void;
  disconnect: () => Promise<void>;
  getActiveAccount: () => Promise<{ accountId: string; walletId: string } | null>;
  signChallenge: (challenge: { message: string; nonceBase64: string; recipient: string; callbackUrl?: string }) => Promise<{ accountId: string; publicKey: string; signature: string }>;
  signAndSendTransactions: (txs: Array<{ receiverId: string; actions: Array<{ type: "FunctionCall"; methodName: string; args: Record<string, unknown>; gas: string; deposit: string }> }>) => Promise<{ txHashes: string[]; raw: unknown }>;
}

let selector: WalletSelector | null = null;
let modal: WalletSelectorModal | null = null;

function mapActions(actions: Array<{ type: "FunctionCall"; methodName: string; args: Record<string, unknown>; gas: string; deposit: string }>): Action[] {
  return actions.map((a) => ({
    type: "FunctionCall",
    params: {
      methodName: a.methodName,
      args: a.args,
      gas: a.gas,
      deposit: a.deposit,
    },
  }));
}

const bridge: SnowMoonWalletBridge = {
  async init({ networkId, contractId, onStateChange }) {
    if (selector) return;
    selector = await setupWalletSelector({
      network: networkId,
      modules: [
        setupMyNearWallet(),
        setupMeteorWallet(),
        setupHereWallet(),
      ],
    });
    modal = setupModal(selector, {
      contractId,
    });
    if (onStateChange) {
      selector.store.observable.subscribe((state: { accounts?: Array<{ accountId: string; publicKey?: string }>; selectedWalletId?: string | null }) => {
        onStateChange(state.accounts || [], state.selectedWalletId || undefined);
      });
    }
  },

  openModal() {
    if (!modal) throw new Error("Wallet Selector not initialized yet.");
    modal.show();
  },

  async disconnect() {
    if (!selector) return;
    const state = selector.store.getState();
    if (state.selectedWalletId) {
      const wallet = await selector.wallet(state.selectedWalletId);
      await wallet.signOut();
    }
  },

  async getActiveAccount() {
    if (!selector) return null;
    const state = selector.store.getState();
    const acct = state.accounts?.[0];
    if (!acct || !state.selectedWalletId) return null;
    return { accountId: acct.accountId, walletId: state.selectedWalletId };
  },

  async signChallenge(challenge) {
    if (!selector) throw new Error("Wallet Selector not initialized.");
    const wallet = await selector.wallet();
    if (typeof wallet.signMessage !== "function") {
      throw new Error(`Selected wallet (${wallet.id}) does not support NEP-413 signMessage.`);
    }
    const nonceBuf = Buffer.from(challenge.nonceBase64, "base64");
    const signed = await wallet.signMessage({
      message: challenge.message,
      nonce: nonceBuf,
      recipient: challenge.recipient,
      callbackUrl: challenge.callbackUrl,
    });
    if (!signed || !signed.signature || !signed.publicKey) {
      throw new Error("Wallet did not return a valid NEP-413 signature.");
    }
    return {
      accountId: signed.accountId,
      publicKey: signed.publicKey,
      signature: signed.signature,
    };
  },

  async signAndSendTransactions(txs) {
    if (!selector) throw new Error("Wallet Selector not initialized.");
    const wallet = await selector.wallet();
    const mapped = txs.map((t) => ({
      receiverId: t.receiverId,
      actions: mapActions(t.actions),
    }));
    const raw = mapped.length === 1
      ? await wallet.signAndSendTransaction(mapped[0])
      : await wallet.signAndSendTransactions({ transactions: mapped });

    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const txHashes: string[] = [];
    for (const item of list) {
      const hash = (item as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } })?.transaction?.hash
        || (item as { transaction_outcome?: { id?: string } })?.transaction_outcome?.id;
      if (hash) txHashes.push(hash);
    }
    return { txHashes, raw };
  },
};

(window as unknown as { SnowMoonWalletSelector: SnowMoonWalletBridge }).SnowMoonWalletSelector = bridge;
