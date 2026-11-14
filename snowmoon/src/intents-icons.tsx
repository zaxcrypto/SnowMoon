import React from "react";
// Classic-JSX icon components inside @aurora-is-near/intents-swap-widget reference global React
(globalThis as unknown as { React: typeof React }).React = React;
import abgSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/abg.svg";
import adaSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/ada.svg";
import aleoSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/aleo.svg";
import arbSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/arb.svg";
import auroraSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/aurora.svg";
import avaxSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/avax.svg";
import baseSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/base.svg";
import bchSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/bch.svg";
import beraSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/bera.svg";
import bnbSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/bnb.svg";
import bscSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/bsc.svg";
import btcSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/btc.svg";
import cardanoSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/cardano.svg";
import daiSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/dai.svg";
import dashSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/dash.svg";
import dogeSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/doge.svg";
import ethSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/eth.svg";
import fraxSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/frax.svg";
import gnosisSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/gnosis.svg";
import ltcSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/ltc.svg";
import monSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/mon.svg";
import nearSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/near.svg";
import opSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/op.svg";
import plasmaSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/plasma.svg";
import polSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/pol.svg";
import scrollSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/scroll.svg";
import stellarSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/stellar.svg";
import suiSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/sui.svg";
import tonSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/ton.svg";
import tronSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/tron.svg";
import usdcSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/usdc.svg";
import usdtSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/usdt.svg";
import wbtcSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/wbtc.svg";
import xdaiSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/xdai.svg";
import xlayerSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/xlayer.svg";
import xrpSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/xrp.svg";
import zecSvg from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/zec.svg";
import { SolIcon as RawSolIcon } from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/SolIcon";
import { StarknetIcon as RawStarknetIcon } from "../node_modules/@aurora-is-near/intents-swap-widget/src/icons/StarknetIcon";

const SolIcon = RawSolIcon as React.ComponentType<{ width?: number; height?: number }>;
const StarknetIcon = RawStarknetIcon as React.ComponentType<{ width?: number; height?: number }>;

const CHAIN_SVG_MAP: Record<string, string> = {
  arb: arbSvg,
  arbitrum: arbSvg,
  aurora: auroraSvg,
  avax: avaxSvg,
  avalanche: avaxSvg,
  base: baseSvg,
  bch: bchSvg,
  bera: beraSvg,
  bsc: bscSvg,
  btc: btcSvg,
  cardano: cardanoSvg,
  dash: dashSvg,
  doge: dogeSvg,
  eth: ethSvg,
  ethereum: ethSvg,
  gnosis: gnosisSvg,
  ltc: ltcSvg,
  monad: monSvg,
  near: nearSvg,
  op: opSvg,
  optimism: opSvg,
  plasma: plasmaSvg,
  pol: polSvg,
  polygon: polSvg,
  scroll: scrollSvg,
  stellar: stellarSvg,
  sui: suiSvg,
  ton: tonSvg,
  tron: tronSvg,
  xlayer: xlayerSvg,
  xrp: xrpSvg,
  zec: zecSvg,
  aleo: aleoSvg,
};

const TOKEN_SVG_MAP: Record<string, string> = {
  abg: abgSvg,
  ada: adaSvg,
  aleo: aleoSvg,
  arb: arbSvg,
  avax: avaxSvg,
  bch: bchSvg,
  bera: beraSvg,
  bnb: bnbSvg,
  btc: btcSvg,
  dai: daiSvg,
  dash: dashSvg,
  doge: dogeSvg,
  eth: ethSvg,
  weth: ethSvg,
  frax: fraxSvg,
  gno: gnosisSvg,
  ltc: ltcSvg,
  mon: monSvg,
  near: nearSvg,
  wnear: nearSvg,
  op: opSvg,
  pol: polSvg,
  matic: polSvg,
  sui: suiSvg,
  ton: tonSvg,
  trx: tronSvg,
  tron: tronSvg,
  usdc: usdcSvg,
  "usdc.e": usdcSvg,
  usdcx: usdcSvg,
  usdt: usdtSvg,
  "usdt.e": usdtSvg,
  usdt0: usdtSvg,
  wbtc: wbtcSvg,
  xdai: xdaiSvg,
  xlm: stellarSvg,
  xrp: xrpSvg,
  zec: zecSvg,
};

export function ChainLogo({
  blockchain,
  size = 16,
}: {
  blockchain: string;
  size?: number;
}) {
  const key = blockchain.toLowerCase();
  if (key === "sol" || key === "solana") {
    return (
      <span
        style={{
          width: size,
          height: size,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        <SolIcon width={size} height={size} />
      </span>
    );
  }
  if (key === "starknet") {
    return (
      <span
        style={{
          width: size,
          height: size,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        <StarknetIcon width={size} height={size} />
      </span>
    );
  }

  const svg = CHAIN_SVG_MAP[key];
  if (svg) {
    return (
      <img
        src={svg}
        alt={blockchain}
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          objectFit: "cover",
          display: "block",
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "#2d2d3d",
        color: "#d4d4e8",
        fontSize: Math.max(8, Math.round(size * 0.5)),
        fontWeight: 700,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {blockchain.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function TokenWithChainIcon({
  symbol,
  blockchain,
  size = 30,
  ringColor = "#1b1b26",
}: {
  symbol: string;
  blockchain: string;
  size?: number;
  ringColor?: string;
}) {
  const symKey = symbol.toLowerCase();
  const normalizedKey = symKey.replace(/\.e$/, "");
  const svg =
    TOKEN_SVG_MAP[symKey] ||
    TOKEN_SVG_MAP[normalizedKey] ||
    (symKey === "sol" ? undefined : CHAIN_SVG_MAP[symKey]);
  const badgeSize = Math.max(12, Math.round(size * 0.46));

  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {symKey === "sol" ? (
        <span
          style={{
            width: size,
            height: size,
            borderRadius: "50%",
            overflow: "hidden",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#111118",
          }}
        >
          <SolIcon width={size} height={size} />
        </span>
      ) : svg ? (
        <img
          src={svg}
          alt={symbol}
          width={size}
          height={size}
          style={{
            width: size,
            height: size,
            borderRadius: "50%",
            objectFit: "cover",
            display: "block",
          }}
        />
      ) : (
        <span
          style={{
            width: size,
            height: size,
            borderRadius: "50%",
            background: "#2a2a3a",
            border: "1px solid rgba(255,255,255,0.12)",
            color: "#e6e6f2",
            fontSize: Math.max(10, Math.round(size * 0.36)),
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {symbol.slice(0, 3).toUpperCase()}
        </span>
      )}

      {/* Small Chain Sub-Badge on bottom-right corner (Rhea style) */}
      <span
        style={{
          position: "absolute",
          bottom: -2,
          right: -2,
          width: badgeSize,
          height: badgeSize,
          borderRadius: "50%",
          background: ringColor,
          border: `1.5px solid ${ringColor}`,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <ChainLogo blockchain={blockchain} size={badgeSize - 2} />
      </span>
    </div>
  );
}
