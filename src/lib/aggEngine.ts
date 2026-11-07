// @ts-nocheck
/**
 * Cross-chain quote engine — ported from the DEX aggregator site
 * (~/workspace/dex-aggregator/docs/app.js, same author's MIT code).
 *
 * Only the read-only quote / tx-building closure is ported:
 * CHAINS (42 Chain + QL1), BRIDGE_PAIRS, same-chain route search,
 * quoteCrossPlan (42 -> QL1 end-to-end), evaluateCrossSplit /
 * evaluateCrossSplitNet (split plans, net of extra bridge fees),
 * and the calldata builders (buildSwapTx / buildApproveTx /
 * buildBridgeTx) plus arrival helpers (fetchBridgeDelivered,
 * extractMessageId). The code is plain JS-style (BigInt only, raw
 * JSON-RPC via fetch) so the Node harness can load it exactly as
 * the app does. No keys, no sends happen in this module.
 *
 * Browser-isms of the original are stubbed: `state` (only the
 * token-customisation slot is consulted, always empty here) and
 * `t()` (error-message keys are returned untranslated; the UI
 * never shows them raw).
 */
const state = { chainKey: "infinite", custom: { infinite: [], ql1: [] }, gasPrice: null };
function t(key, ...args) { return key; }

const NATIVE_PH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const WQOM = "0xa26dfbf98dd1a32fae56a3d2b2d60a8a41b0bdf0";

const CHAINS = {
  infinite: {
    key: "infinite", label: "42 Chain", chainId: 421018,
    nativeSymbol: "42", nativeName: "Infinite Drivechain",
    rpcs: ["https://evm-rpc.infinitedrive.xyz", "https://evm-rpc-infinite.mschihuahua.org", "https://evm-rpc.infinitepanda.xyz"],
    explorer: "https://scan.infinitedrive.xyz",
    router: "0xbf07dfe35746894bae373f63f4bf2379f9bafec0",
    factory: "0x3157c6aca800d507af95ab1466adbA3a6f11eE1a",
    nativeAnchor: NATIVE_PH, aggregator: "", isTestnet: false,
    tokens: [
      { id: "native", symbol: "42", name: "42 (native)", address: NATIVE_PH, decimals: 18, isNative: true },
      { id: "usdt", symbol: "USDT", name: "Bridged USDT", address: "0xc2684966e5c95b2bc636fb4a1f3da9ad23d94753", decimals: 18, isNative: false },
      { id: "usdc", symbol: "USDC", name: "Bridged USDC", address: "0xea5b7fd59b7ec0f34663835a3a361f469c2d4c5c", decimals: 18, isNative: false },
      { id: "fish", symbol: "FISH", name: "FISH", address: "0x2c32120a12b754272d9e85c57f64b50ca2c43513", decimals: 18, isNative: false },
      { id: "panic", symbol: "PANIC", name: "Dont Panic (DONT)", address: "0xfaa842c8871f7f99c183f77871f79ce07dd056cd", decimals: 18, isNative: false },
      { id: "zap", symbol: "ZAP", name: "ZAP", address: "0x89195ca5c954b6f99b78f4a2aa5435a75dc5b256", decimals: 18, isNative: false },
      { id: "cat42", symbol: "CAT42", name: "CAT42", address: "0x7386719ebbbeb4d810ff89027bfb8a1cdf696310", decimals: 18, isNative: false },
      { id: "father", symbol: "FATHER", name: "FATHER", address: "0x8981f00e92f31a87af12f980383d2217706258e7", decimals: 18, isNative: false },
      { id: "ket", symbol: "KET", name: "KET", address: "0xb749d42e6004db590b2f04f32b87485402a061e2", decimals: 18, isNative: false },
      { id: "baby", symbol: "BABY", name: "BABY", address: "0x77479226c103cc3c142faff6691bc7f849ce9c92", decimals: 18, isNative: false },
      { id: "qom", symbol: "QOM", name: "QOM (Infinite)", address: "0x53465cbbba5b14f5dc00794330f0f4afb30eaa1d", decimals: 18, isNative: false },
      { id: "marvin", symbol: "MARVIN", name: "MARVIN", address: "0xa307362f8a756722541dde6255aecf64f35ba337", decimals: 18, isNative: false },
      { id: "o", symbol: "O", name: "O", address: "0xf4c14c0322e361f35eb9465c992fb1c21c91c156", decimals: 18, isNative: false },
      { id: "osak", symbol: "OSAK", name: "OSAK", address: "0x404f3a213ff6c5d654f4e95e6a7ed098b1c3d3b3", decimals: 18, isNative: false },
      { id: "fox", symbol: "FOXXEY", name: "FOXXEY", address: "0x68d5a28d3bf09a32d3b9c35714ab7a6166ae2a00", decimals: 18, isNative: false },
      { id: "bfoxx", symbol: "BFOXX", name: "BFOXX", address: "0x3a921a988099374c65433208a452195ea6a1e116", decimals: 18, isNative: false },
      { id: "hawk", symbol: "HAWK", name: "HAWK", address: "0x4e3e79981a64d5678e2e70fd7b4b9550c2b41db2", decimals: 18, isNative: false },
      { id: "caw", symbol: "CAW", name: "CAW", address: "0xce8aee7148daa8943453239c42b7b93f984a49f0", decimals: 18, isNative: false },
      { id: "st42", symbol: "st42", name: "Staked 42 (stC2)", address: "0x78f40e828a92af9e137ff7660e52ac8b0f1d121e", decimals: 18, isNative: false },
    ],
    baseAddresses: [NATIVE_PH, "0xc2684966e5c95b2bc636fb4a1f3da9ad23d94753", "0xea5b7fd59b7ec0f34663835a3a361f469c2d4c5c", "0x2c32120a12b754272d9e85c57f64b50ca2c43513", "0x53465cbbba5b14f5dc00794330f0f4afb30eaa1d", "0x89195ca5c954b6f99b78f4a2aa5435a75dc5b256", "0xfaa842c8871f7f99c183f77871f79ce07dd056cd"],
    defaultFrom: "usdt", defaultTo: "native",
  },
  ql1: {
    key: "ql1", label: "QL1", chainId: 766,
    nativeSymbol: "QOM", nativeName: "QOM Layer One",
    rpcs: ["https://evm-rpc-ql1.mschihuahua.org"],
    explorer: "https://scan.qom.network",
    router: "0xc1f90231035a52091ebcb7dddaCa3051a5F44f30".toLowerCase(),
    factory: "0x475f361993d6facbf32fb82b66be0fb40f3d974c",
    nativeAnchor: WQOM, aggregator: "", isTestnet: false,
    tokens: [
      { id: "native", symbol: "QOM", name: "QOM (native)", address: WQOM, decimals: 18, isNative: true },
      { id: "wqom", symbol: "WQOM", name: "Wrapped QOM", address: WQOM, decimals: 18, isNative: false },
      { id: "qusdt", symbol: "qUSDT", name: "USDT FROM ETHEREUM", address: "0xc276b91c0e8d10260af7b67009d2683bb7776308", decimals: 6, isNative: false },
      { id: "qusdc", symbol: "qUSDC", name: "USDC FROM ETHEREUM", address: "0xb0a125e9673dc8e12bbcd0769c1257cf4a836d54", decimals: 6, isNative: false },
      { id: "qdai", symbol: "qDAI", name: "DAI FROM ETHEREUM", address: "0x8cb00ee173ae1c35d66118b7e08a69a0d4da06f2", decimals: 18, isNative: false },
      { id: "qswap", symbol: "QSWAP", name: "QOMSWAP", address: "0x4af41f453ead00d1cc6aa0b5b454bdeb102afc8d", decimals: 18, isNative: false },
      { id: "zap", symbol: "ZAP", name: "ZAP (QL1)", address: "0x6041b64618434b9d0a9558b5975c5c1deb45cee6", decimals: 18, isNative: false },
      { id: "baby", symbol: "BABY", name: "A Fund Baby", address: "0x4667fc0a4b996e0f997313a49de48036b584ef22", decimals: 18, isNative: false },
      { id: "ket", symbol: "KET", name: "Ryoshi Afterparty", address: "0x034c1fe794ab9d30e27e1ce0d89a4591fc9f1fb4", decimals: 18, isNative: false },
      { id: "hawk", symbol: "HAWK", name: "HAWK", address: "0xbc85f14059d60458b614052b4a84734e463878cc", decimals: 18, isNative: false },
      { id: "father", symbol: "Father", name: "Robert A. Heinlein", address: "0x2860ec7c34b29f3d2b43788c9a5f0de051f799bb", decimals: 18, isNative: false },
      { id: "o", symbol: "O", name: "Childhoods End", address: "0x6c39b68a28ba90f4eb80032ec0eb32ad81cbbed4", decimals: 18, isNative: false },
      { id: "qosak", symbol: "qOSAK", name: "OSAK FROM ETHEREUM", address: "0x5b6af20880a583128170d8c1fc319889ff405a5a", decimals: 18, isNative: false },
      { id: "qcaw", symbol: "CAW", name: "CAW FROM ETHEREUM", address: "0xd2140e16adf37194036865e90bbca1139b739d0d", decimals: 18, isNative: false },
    ],
    baseAddresses: [WQOM, "0xc276b91c0e8d10260af7b67009d2683bb7776308", "0xb0a125e9673dc8e12bbcd0769c1257cf4a836d54", "0x8cb00ee173ae1c35d66118b7e08a69a0d4da06f2", "0x4af41f453ead00d1cc6aa0b5b454bdeb102afc8d"],
    defaultFrom: "qusdt", defaultTo: "native",
  },
};

const BRIDGE_PAIRS = [
  { sym: "QOM",    infId: "qom",    ql1Id: "wqom",  br: "0x049a78fe311cf1c23f09cdd4f12420ffc917c8db", ql1Router: "0x30da1e7c8de5fa75b593002e0b2d2910ffcadcb6", enabledFromQl1: true, enabledFromInf: true },
  { sym: "BABY",   infId: "baby",   ql1Id: "baby",  br: "0x4aba9dbe8a990c19501c1c4c3e677f775006d2e2", ql1Router: "0x8ff9452f309159828903d2d6cca58cccb2b5cd16", enabledFromQl1: true, enabledFromInf: true },
  { sym: "CAW",    infId: "caw",    ql1Id: "qcaw",  br: "0x82ba5d61a70677f7f53a9894c63dfb61fd8bcb65", ql1Router: "0xd14cf03d3753d80a1f6fb818aa1c728d5c36b3bf", enabledFromQl1: true, enabledFromInf: true },
  { sym: "FATHER", infId: "father", ql1Id: "father", br: "0x056c116c09acb788d038e7dDc167249C26493D6e", ql1Router: "0x54718de5e064dcd1181b7847591c5864434ed92e", enabledFromQl1: true, enabledFromInf: true },
  { sym: "HAWK",   infId: "hawk",   ql1Id: "hawk",  br: "0x0d198200dc673e96217ddeA9560d26Ae0d092074", ql1Router: "0x916fb1a761d0db8888c3f79d6c614c9ffF73b657".toLowerCase(), enabledFromQl1: true, enabledFromInf: true },
  { sym: "KET",    infId: "ket",    ql1Id: "ket",   br: "0x3bc94e9f417561ca37559e07dfc65496fcE94557", ql1Router: "0x59d6e50f5b0559a088e3eaac21e520be18453704", enabledFromQl1: true, enabledFromInf: true },
  { sym: "O",      infId: "o",      ql1Id: "o",     br: "0xcb893a7e5f2932531f6e04c0Fc3b17AC4884475f", ql1Router: "0x488b1f39aa01196ec8a14891bAfFEe6630155A61", enabledFromQl1: true, enabledFromInf: true },
  { sym: "OSAK",   infId: "osak",   ql1Id: "qosak", br: "0xa2093426c03ba6F0f6049532b6f13F1e36566358", ql1Router: "0xe3a35d9f4ef7eacD5bb47164Ee8d7bff75C2cF6B", enabledFromQl1: true, enabledFromInf: false },
];
const BRIDGE_MAILBOX = { infinite: "0xac70cdd7f2b712aef7a20661e0c2e96e1da1d63e", ql1: "0x2f136baa37eb5711483d295944eeda01c4142da0" };
const TOPIC_BRIDGE_INITIATED = "0x8f90f45f78e58a284c9aa2b93fed3647c4fed38904c460c2c07a6f5a26f2c1fd";
const TOPIC_DISPATCH_ID = "0x788dbc1b7152732178210e7f4d9d010ef016f9eafbe66786bd7169f56e0c353a";

const SEL = {
  getAmountsOut: "0xd06ca61f", getPair: "0xe6a43905", getReserves: "0x0902f1ac", token0: "0x0dfe1681",
  transferRemote: "0x81b4e8b4", quoteNative: "0xe9e64e40", quoteBridge: "0x15b2393a", mailboxDelivered: "0xe495f1d4",
  symbol: "0x95d89b41", name: "0x06fdde03", decimals: "0x313ce567",
  balanceOf: "0x70a08231", allowance: "0xdd62ed3e", approve: "0x095ea7b3",
  swapTokensForTokens: "0x38ed1739", swapETHForTokens: "0x7ff36ab5", swapTokensForETH: "0x18cbafe5",
  // contracts/SplitSwap.sol のセレクタ (v7 で Leg に amountOutMin を追加した
  // 再コンパイル済みABIから取得。solc 0.8.26 / optimizer 200 runs / EVM paris)
  split: "0x2f88d6d5",            // swapSplit(address,(uint256,uint256,address[])[],uint256,address,address,uint256)
  splitToNative: "0xdbbdfd97",    // swapSplitToNative(address,(uint256,uint256,address[])[],uint256,address,uint256)
  splitFromNative: "0xc5b2c8c4",  // swapSplitFromNative((uint256,uint256,address[])[],uint256,address,address,uint256)
  splitRouter: "0xf887ea40",      // SplitSwap.router()
};
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/* ガス目安 (実測ではなくホップ数からの近似。画面でも「目安」と明記する) */
const GAS_BASE = 65000, GAS_PER_HOP = 105000, GAS_AGG_OVERHEAD = 90000, GAS_LEG_BASE = 35000;
function estimateGasUnitsSingle(route) { return GAS_BASE + GAS_PER_HOP * route.hops; }
function estimateGasUnitsSplit(legs) { return GAS_AGG_OVERHEAD + legs.reduce((s, l) => s + GAS_LEG_BASE + GAS_PER_HOP * l.route.hops, 0); }

function chain() { return CHAINS[state.chainKey]; }
/* ---------- v7: SplitSwap (aggregator) address resolution ----------
   分割実行に使えるアグリゲーター住所は2か所から決まる:
   1) CHAINS の内蔵スロット (aggregator) — デプロイ済みの既定住所が入れば最優先。
   2) このブラウザの localStorage (dexagg_aggregator_v1) — サイト内の
      「アグリゲーターをデプロイ」でユーザーが自分のウォレットからデプロイ
      した住所。チェーンごとに保存する。 */
const AGG_KEY = "dexagg_aggregator_v1";
function loadAggStore() { return {}; }
function loadAggStoreUnused() {
  try { const v = JSON.parse(localStorage.getItem(AGG_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; }
}
function storedAggregator(chainKey) {
  const v = loadAggStore()[chainKey];
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null;
}
function setStoredAggregator(chainKey, addr) {
  const s = loadAggStore();
  if (addr) s[chainKey] = addr.toLowerCase(); else delete s[chainKey];
  try { localStorage.setItem(AGG_KEY, JSON.stringify(s)); } catch (e) { /* storage unavailable */ }
}
function effectiveAggregator(chainObj) {
  if (!chainObj) return null;
  if (chainObj.aggregator && chainObj.aggregator.length === 42) return chainObj.aggregator.toLowerCase();
  return storedAggregator(chainObj.key);
}
function aggregatorSource(chainObj) {
  if (!chainObj) return null;
  if (chainObj.aggregator && chainObj.aggregator.length === 42) return "builtin";
  return storedAggregator(chainObj.key) ? "local" : null;
}
function splitExecutable(chainObj) { return !!effectiveAggregator(chainObj); }
function allTokens(chainKey) {
  const c = CHAINS[chainKey || state.chainKey];
  return [...c.tokens, ...state.custom[c.key]];
}
function tokenById(chainKey, id) { return allTokens(chainKey).find((tk) => tk.id === id) || null; }
function tokenByAddress(chainKey, addr) {
  const a = (addr || "").toLowerCase();
  const list = allTokens(chainKey);
  return list.find((tk) => tk.isNative && tk.address.toLowerCase() === a) || list.find((tk) => tk.address.toLowerCase() === a) || null;
}
function symbolFor(chainKey, addr) {
  const tk = tokenByAddress(chainKey, addr);
  return tk ? tk.symbol : (addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "?");
}

/* ---------- amount helpers (BigInt only) ---------- */

function parseAmount(text, decimals) {
  const s = String(text == null ? "" : text).trim();
  if (!s || !/^\d*(\.\d*)?$/.test(s) || s === ".") throw new Error(t("errAmountFormat"));
  const [ip, fpRaw = ""] = s.split(".");
  if (fpRaw.length > decimals) throw new Error(t("errTooManyDecimals", decimals));
  const fp = fpRaw.padEnd(decimals, "0");
  return BigInt(ip || "0") * (10n ** BigInt(decimals)) + (fp ? BigInt(fp) : 0n);
}
function formatAmount(raw, decimals, maxFrac) {
  if (raw == null) return "—";
  const neg = raw < 0n; const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const ip = v / base; let fp = (v % base).toString().padStart(decimals, "0");
  if (maxFrac != null) {
    fp = fp.slice(0, maxFrac);
    if (ip === 0n && !/[1-9]/.test(fp)) {
      const full = (v % base).toString().padStart(decimals, "0");
      const first = full.search(/[1-9]/);
      if (first >= 0) fp = full.slice(0, Math.min(decimals, first + 4));
    }
  }
  fp = fp.replace(/0+$/, "");
  const ipStr = ip.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + ipStr + (fp ? "." + fp : "");
}
function formatRate(fromTok, toTok, amountIn, amountOut, invert) {
  if (!amountIn || amountIn <= 0n || !amountOut || amountOut <= 0n) return "";
  // rate = (out / 10^toDec) / (in / 10^fromDec), 1e6 精度で BigInt 計算
  let num, den;
  if (!invert) { num = amountOut * (10n ** BigInt(fromTok.decimals + 6)); den = amountIn * (10n ** BigInt(toTok.decimals)); }
  else { num = amountIn * (10n ** BigInt(toTok.decimals + 6)); den = amountOut * (10n ** BigInt(fromTok.decimals)); }
  const q = Number(num / den) / 1e6;
  const a = invert ? toTok.symbol : fromTok.symbol, b = invert ? fromTok.symbol : toTok.symbol;
  return "1 " + a + " = " + (q >= 1000 ? q.toLocaleString("en-US", { maximumFractionDigits: 4 }) : q.toPrecision(6).replace(/\.?0+$/, "")) + " " + b;
}

/* ---------- ABI encoding helpers ---------- */
function encAddr(a) { return a.toLowerCase().replace("0x", "").padStart(64, "0"); }
function encUint(n) { return BigInt(n).toString(16).padStart(64, "0"); }
function decUint(hex) { return hex && hex !== "0x" ? BigInt(hex) : null; }
function decAddr(hex) { return hex && hex.length >= 42 ? "0x" + hex.slice(-40).toLowerCase() : null; }
function decStr(hex) {
  if (!hex || hex === "0x") return null;
  try {
    const b = hex.slice(2);
    if (b.length === 64) {
      let s = ""; for (let i = 0; i < 64; i += 2) { const c = parseInt(b.substr(i, 2), 16); if (c) s += String.fromCharCode(c); }
      return s || null;
    }
    const len = Number(BigInt("0x" + b.substr(64, 64)));
    const raw = b.substr(128, len * 2); const bytes = [];
    for (let i = 0; i < raw.length; i += 2) bytes.push(parseInt(raw.substr(i, 2), 16));
    return new TextDecoder().decode(new Uint8Array(bytes));
  } catch (e) { return null; }
}
function encodeGetAmountsOut(amountIn, pathAddrs) {
  return SEL.getAmountsOut + encUint(amountIn) + encUint(64) + encUint(pathAddrs.length) + pathAddrs.map(encAddr).join("");
}
function decodeAmountsOut(hex) {
  if (!hex || hex === "0x" || hex.length < 128) return null;
  try {
    const len = Number(BigInt("0x" + hex.slice(66, 130)));
    const out = [];
    for (let i = 0; i < len; i++) out.push(BigInt("0x" + hex.slice(130 + i * 64, 194 + i * 64)));
    return out;
  } catch (e) { return null; }
}
/* SplitSwap の Leg[] ((uint256 amountIn, uint256 amountOutMin, address[] path)[])
   の tail エンコーディング (v7: レッグごとの最低受取量を含む) */
function encLegsTail(legs) {
  const elems = legs.map((leg) => encUint(leg.amountIn) + encUint(leg.amountOutMin || 0n) + encUint(96) + encUint(leg.path.length) + leg.path.map(encAddr).join(""));
  let off = 32 * elems.length; const offsets = [];
  for (const e of elems) { offsets.push(encUint(off)); off += e.length / 2; }
  return encUint(elems.length) + offsets.join("") + elems.join("");
}

/* ---------- RPC (public, read-only) ---------- */
let rpcId = 0;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
/* v0.3.2 robustness: a single stalled/failed call on mobile data used
   to kill the whole quote. Transport failures (fetch rejection, HTTP
   error, bad body, abort) now RETRY — 2 retries with short backoff —
   and every attempt is time-boxed so a hang becomes a failure the
   retry/fallback logic can route around. Per-call JSON-RPC errors
   (reverts) are NOT throws here: they come back as null results and
   are never retried. */
const RPC_RETRIES = 2;
const RPC_TIMEOUT_MS = 20000;
async function fetchJson(url, body) {
  let ctrl = null, timer = null;
  try {
    if (typeof AbortController !== "undefined") {
      ctrl = new AbortController();
      timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* noop */ } }, RPC_TIMEOUT_MS);
    }
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    if (!res.ok) throw new Error("RPC HTTP " + res.status);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function rpcBatchOnce(url, calls) {
  const start = rpcId;
  const payload = calls.map(([to, data]) => ({ jsonrpc: "2.0", id: ++rpcId, method: "eth_call", params: [{ to, data }, "latest"] }));
  const out = await fetchJson(url, JSON.stringify(payload));
  if (!Array.isArray(out)) throw new Error("RPC bad response");
  const byId = {};
  for (const x of out) byId[x.id] = x.error ? null : (x.result || null);
  return calls.map((_, i) => byId[start + i + 1] || null);
}
async function rpcBatch(chainObj, calls) {
  let lastErr = null;
  for (const url of chainObj.rpcs) {
    for (let attempt = 0; attempt <= RPC_RETRIES; attempt++) {
      try { return await rpcBatchOnce(url, calls); } catch (e) {
        lastErr = e;
        if (attempt < RPC_RETRIES) await sleepMs(300 * (attempt + 1));
      }
    }
  }
  throw lastErr || new Error("RPC unreachable");
}
async function rpcOne(chainObj, to, data) { return (await rpcBatch(chainObj, [[to, data]]))[0]; }
async function rpcMethod(chainObj, method, params) {
  let lastErr = null;
  for (const url of chainObj.rpcs) {
    for (let attempt = 0; attempt <= RPC_RETRIES; attempt++) {
      try {
        const j = await fetchJson(url, JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }));
        if (j.error) throw new Error(j.error.message || "RPC error");
        return j.result;
      } catch (e) {
        lastErr = e;
        if (attempt < RPC_RETRIES) await sleepMs(300 * (attempt + 1));
      }
    }
  }
  throw lastErr || new Error("RPC unreachable");
}
/* Run fn over items with at most `limit` promises in flight; the
   result array keeps the input order, so callers stay deterministic. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  const workers = [];
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}
/* Quote getAmountsOut for many paths of one (from -> to) pair.
   Fast path: ONE batched call. If the batch itself fails at
   transport level, fall back to quoting paths one by one (bounded
   concurrency): a path that still fails comes back null — only that
   route disappears, never the whole plan (v0.3.2 per-candidate
   isolation). Returns hex results aligned with `paths`; never throws. */
async function quoteAmountsOutByPath(chainObj, amountIn, paths) {
  const calls = paths.map((p) => [chainObj.router, encodeGetAmountsOut(amountIn, p)]);
  try {
    return await rpcBatch(chainObj, calls);
  } catch (e) {
    let consecutiveFails = 0;
    return mapLimit(calls, 4, async (c) => {
      if (consecutiveFails >= 4) return null; // endpoint looks down; stop burning time
      try {
        const r = (await rpcBatch(chainObj, [c]))[0];
        consecutiveFails = 0;
        return r || null;
      } catch (e2) {
        consecutiveFails++;
        return null;
      }
    });
  }
}

/* ---------- route enumeration ---------- */
function buildCandidatePaths(chainObj, fromTok, toTok) {
  const from = fromTok.address.toLowerCase(), to = toTok.address.toLowerCase();
  const bases = chainObj.baseAddresses.map((a) => a.toLowerCase()).filter((a) => a !== from && a !== to);
  const paths = [[from, to]];
  for (const x of bases) paths.push([from, x, to]);
  for (const x of bases) for (const y of bases) { if (x !== y) paths.push([from, x, y, to]); }
  const seen = new Set(); const out = [];
  for (const p of paths) { const k = p.join(","); if (!seen.has(k)) { seen.add(k); out.push(p); } }
  return out;
}
async function fetchPairs(chainObj, routes) {
  const keys = new Set();
  for (const r of routes) for (let i = 0; i < r.path.length - 1; i++) keys.add(r.path[i] + "," + r.path[i + 1]);
  const keyArr = [...keys];
  const pairRes = await rpcBatch(chainObj, keyArr.map((k) => { const [a, b] = k.split(","); return [chainObj.factory, SEL.getPair + encAddr(a) + encAddr(b)]; }));
  const pairOf = new Map();
  keyArr.forEach((k, i) => { const p = decAddr(pairRes[i]); if (p && p !== ZERO_ADDR) pairOf.set(k, p); });
  const uniqPairs = [...new Set(pairOf.values())];
  const detail = await rpcBatch(chainObj, uniqPairs.flatMap((p) => [[p, SEL.getReserves], [p, SEL.token0]]));
  const info = new Map();
  uniqPairs.forEach((p, i) => {
    const raw = detail[i * 2]; const t0 = decAddr(detail[i * 2 + 1]);
    if (!raw || raw.length < 130 || !t0) return;
    try { info.set(p, { r0: BigInt("0x" + raw.slice(2, 66)), r1: BigInt("0x" + raw.slice(66, 130)), token0: t0 }); } catch (e) { /* skip */ }
  });
  return { pairOf, info };
}
function spotOutFor(route, amountIn, pairOf, info) {
  let cur = amountIn;
  for (let i = 0; i < route.path.length - 1; i++) {
    const pair = pairOf.get(route.path[i] + "," + route.path[i + 1]);
    if (!pair) return null;
    const d = info.get(pair); if (!d) return null;
    const inIs0 = d.token0 === route.path[i];
    const rIn = inIs0 ? d.r0 : d.r1; const rOut = inIs0 ? d.r1 : d.r0;
    if (rIn === 0n || rOut === 0n) return null;
    cur = (cur * rOut) / rIn;
  }
  return cur;
}

/* ---------- split allocation refinement (generic hill climbing) ----------
   配分 [{cand, pct}] (pct 合計 100) を、ステップ幅 5% → 2% → 1% の順に
   「1パートから別パートへ step% 移す」「未使用の候補を 1% で追加する
   (既存パートから比例的に削る)」ムーブを全て評価し、最良の改善を採用
   し続ける。改善ムーブが無くなったら止まる (局所最適)。scoreMany は
   配分の配列を受け取り、各配分の {totalOut, ...} か null を返す非同期
   関数 (呼び出し側が見積もりを一括実行する)。 */
async function refineSplitAllocation(startAlloc, startScore, scoreMany, opts) {
  const o = opts || {};
  const maxParts = o.maxParts || 5;
  const maxIterations = o.maxIterations || 150;
  const steps = o.steps || [5, 2, 1];
  const allowed = o.allowed || (() => true);
  const addCandidates = o.addCandidates || [];
  const keyOf = o.keyOf || ((c) => c);
  const budget = o.budget || null;
  let cur = startAlloc.map((p) => ({ cand: p.cand, pct: p.pct }));
  let curScore = startScore;
  let iterations = 0, evaluatedMoves = 0;
  const sigOf = (alloc) => alloc.map((p) => keyOf(p.cand) + ":" + p.pct).sort().join(",");
  const genMoves = (alloc, step) => {
    const moves = [];
    const seen = new Set([sigOf(alloc)]);
    const push = (a) => {
      if (a.length < 2 || a.length > maxParts) return;
      const s = sigOf(a);
      if (seen.has(s)) return;
      seen.add(s); moves.push(a);
    };
    for (let i = 0; i < alloc.length; i++) {
      for (let j = 0; j < alloc.length; j++) {
        if (i === j || alloc[i].pct < step) continue;
        const na = alloc.map((p) => ({ cand: p.cand, pct: p.pct }));
        na[i].pct -= step; na[j].pct += step;
        const f = na.filter((p) => p.pct > 0);
        if (f.length < 2) continue;
        if (!allowed(f.map((p) => p.cand))) continue;
        push(f);
      }
    }
    if (alloc.length < maxParts) {
      const inPlan = new Set(alloc.map((p) => keyOf(p.cand)));
      for (const cand of addCandidates) {
        if (inPlan.has(keyOf(cand))) continue;
        if (!allowed([...alloc.map((p) => p.cand), cand])) continue;
        const na = alloc.map((p) => ({ cand, pct: Math.floor((p.pct * 99) / 100) })).filter((p) => p.pct > 0);
        if (!na.length) continue;
        let deficit = 99 - na.reduce((s, p) => s + p.pct, 0);
        const order = na.map((p, i) => i).sort((a, b) => na[b].pct - na[a].pct);
        for (let k = 0; deficit > 0 && order.length; k++) { na[order[k % order.length]].pct += 1; deficit--; }
        na.push({ cand, pct: 1 });
        if (na.reduce((s, p) => s + p.pct, 0) !== 100) continue;
        push(na);
      }
    }
    return moves;
  };
  for (const step of steps) {
    while (iterations < maxIterations) {
      if (budget && !budget()) return { alloc: cur, score: curScore, iterations, evaluatedMoves };
      const moves = genMoves(cur, step);
      if (!moves.length) break;
      const scores = await scoreMany(moves);
      evaluatedMoves += moves.length;
      let bi = -1;
      for (let i = 0; i < moves.length; i++) {
        if (scores[i] && (bi < 0 || scores[i].totalOut > scores[bi].totalOut)) bi = i;
      }
      if (bi >= 0 && scores[bi].totalOut > curScore.totalOut) { cur = moves[bi]; curScore = scores[bi]; iterations++; }
      else break;
    }
    if (iterations >= maxIterations) break;
  }
  return { alloc: cur, score: curScore, iterations, evaluatedMoves };
}

/* ---------- split evaluation (1inch-style allocation search) ----------
   v6.2: ペアは 1% 刻みで全探索し、最良配分を 1% 刻みの微調整
   (refineSplitAllocation) で詰める。同一チェーン側も同じ微調整を使う。 */
async function evaluateSplits(chainObj, routes, amountIn) {
  const top = routes.slice(0, 3);
  if (top.length < 2 || amountIn <= 0n) return { evaluated: 0, best: null, plan: null };
  const routeIdx = new Map(); top.forEach((r, i) => routeIdx.set(r, i));
  // leg amountIns (last leg takes the remainder so the sum is exact)
  const legsOf = (alloc) => {
    const legs = []; let used = 0n;
    alloc.forEach((l, i) => {
      const amt = i === alloc.length - 1 ? amountIn - used : (amountIn * BigInt(l.pct)) / 100n;
      used += amt; legs.push({ route: l.cand, pct: l.pct, amountIn: amt, amountOut: null });
    });
    return legs;
  };
  const cache = new Map(); // "routeIdx|amountIn" -> amountOut | null
  const CHUNK = 150;
  async function ensure(legsList) {
    const missing = [];
    const seen = new Set();
    for (const leg of legsList) {
      if (leg.amountIn <= 0n) continue;
      const key = routeIdx.get(leg.route) + "|" + leg.amountIn.toString();
      if (!cache.has(key) && !seen.has(key)) { seen.add(key); missing.push({ key, leg }); }
    }
    for (let s = 0; s < missing.length; s += CHUNK) {
      const chunk = missing.slice(s, s + CHUNK);
      try {
        const res = await rpcBatch(chainObj, chunk.map((m) => [chainObj.router, encodeGetAmountsOut(m.leg.amountIn, m.leg.route.path)]));
        chunk.forEach((m, k) => { const amts = decodeAmountsOut(res[k]); cache.set(m.key, amts && amts.length ? amts[amts.length - 1] : null); });
      } catch (e) {
        chunk.forEach((m) => cache.set(m.key, null));
      }
    }
  }
  const scoreFromCache = (alloc) => {
    const legs = legsOf(alloc);
    if (legs.some((l) => l.amountIn <= 0n)) return null;
    let total = 0n;
    for (const leg of legs) {
      const out = cache.get(routeIdx.get(leg.route) + "|" + leg.amountIn.toString());
      if (out == null || out <= 0n) return null;
      leg.amountOut = out; total += out;
    }
    return { legs, totalOut: total };
  };
  let evaluated = 0;
  let best = null;
  const considerAll = async (allocs) => {
    if (!allocs.length) return;
    await ensure(allocs.flatMap(legsOf));
    for (const a of allocs) {
      evaluated++;
      const s = scoreFromCache(a);
      if (s && (!best || s.totalOut > best.totalOut)) best = s;
    }
  };
  // stage 1: pairs at 1% steps among the top routes + classic triple templates
  const allocs = [];
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++)
    for (let p = 1; p <= 99; p++) allocs.push([{ cand: top[i], pct: p }, { cand: top[j], pct: 100 - p }]);
  if (top.length >= 3) for (const sh of [[50, 30, 20], [40, 30, 30], [60, 25, 15], [34, 33, 33]]) allocs.push(sh.map((pct, i) => ({ cand: top[i], pct })));
  await considerAll(allocs);
  // stage 2: 1% hill-climb refinement (transfers + adds within the top routes)
  if (best) {
    const scoreMany = async (al) => { await ensure(al.flatMap(legsOf)); return al.map((a) => scoreFromCache(a)); };
    const refined = await refineSplitAllocation(
      best.legs.map((l) => ({ cand: l.route, pct: l.pct })), best, scoreMany,
      { addCandidates: top, maxParts: 3, keyOf: (r) => routeIdx.get(r), maxIterations: 100 });
    evaluated += refined.evaluatedMoves;
    if (refined.score && refined.score.totalOut > best.totalOut) best = refined.score;
  }
  const plan = best && best.totalOut > routes[0].amountOut ? best : null;
  return { evaluated, best, plan };
}

/* ---------- quoting: compare ALL routes + splits ---------- */
async function fetchQuotesForTokens(chainObj, fromTok, toTok, amountIn) {
  if (fromTok.address.toLowerCase() === toTok.address.toLowerCase()) throw new Error(t("errSameToken"));
  if (amountIn <= 0n) throw new Error(t("errAmountPositive"));
  const paths = buildCandidatePaths(chainObj, fromTok, toTok);
  const results = await quoteAmountsOutByPath(chainObj, amountIn, paths);
  const routes = [];
  results.forEach((hex, i) => {
    const amounts = decodeAmountsOut(hex);
    if (!amounts || !amounts.length) return;
    const out = amounts[amounts.length - 1];
    if (out <= 0n) return;
    routes.push({ path: paths[i], amounts, amountOut: out, hops: paths[i].length - 1, priceImpactPct: null });
  });
  if (!routes.length) throw new Error(t("errNoRoute"));
  routes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
  const direct = routes.find((r) => r.hops === 1) || null;
  try {
    const { pairOf, info } = await fetchPairs(chainObj, routes);
    for (const r of routes) {
      const spot = spotOutFor(r, amountIn, pairOf, info);
      if (spot !== null && spot > 0n) {
        const spotN = Number(spot), outN = Number(r.amountOut);
        if (spotN > 0) r.priceImpactPct = (1 - outN / spotN) * 100;
      }
    }
  } catch (e) { /* impact is optional */ }
  let splitEval = { evaluated: 0, best: null, plan: null };
  try { splitEval = await evaluateSplits(chainObj, routes, amountIn); } catch (e) { /* splits are optional */ }
  const splitEstimate = splitEval.plan ? { out: splitEval.plan.totalOut, bestOut: routes[0].amountOut } : null;
  let gasPrice = null;
  try { const gp = await rpcMethod(chainObj, "eth_gasPrice", []); if (gp) gasPrice = BigInt(gp); } catch (e) { /* optional */ }
  return { routes, directOut: direct ? direct.amountOut : null, splitEstimate, splitEval, gasPrice, amountIn };
}

/* ---------- tx construction (pure; used by send flow AND the harness) ---------- */
function applySlippageBps(amount, slippagePct) {
  const bps = Math.round(Number(slippagePct) * 100);
  return (amount * BigInt(10000 - bps)) / 10000n;
}
function deadline20Min(nowSec) { return (nowSec || Math.floor(Date.now() / 1000)) + 20 * 60; }
function buildSwapTx(chainObj, fromTok, toTok, route, account, slippagePct, nowSec) {
  const amountIn = route.amountIn;
  const amountOutMin = applySlippageBps(route.amountOut, slippagePct);
  const deadline = deadline20Min(nowSec);
  const path = route.path;
  function arrayTail(addrs) { return encUint(addrs.length) + addrs.map(encAddr).join(""); }
  let data, value = 0n, fn;
  if (fromTok.isNative) {
    fn = "swapExactETHForTokens";
    data = SEL.swapETHForTokens + encUint(amountOutMin) + encUint(128) + encAddr(account) + encUint(deadline) + arrayTail(path);
    value = amountIn;
  } else if (toTok.isNative) {
    fn = "swapExactTokensForETH";
    data = SEL.swapTokensForETH + encUint(amountIn) + encUint(amountOutMin) + encUint(160) + encAddr(account) + encUint(deadline) + arrayTail(path);
  } else {
    fn = "swapExactTokensForTokens";
    data = SEL.swapTokensForTokens + encUint(amountIn) + encUint(amountOutMin) + encUint(160) + encAddr(account) + encUint(deadline) + arrayTail(path);
  }
  return { to: chainObj.router, data, value, amountOutMin, deadline, functionName: fn, path };
}
function buildApproveTx(tokenAddr, spender, amount) {
  return { to: tokenAddr.toLowerCase(), data: SEL.approve + encAddr(spender) + encUint(amount), value: 0n };
}
/* SplitSwap の作成バイトコード (contracts/SplitSwap.json と同一。solc
   0.8.26 + optimizer 200 runs、EVM ターゲット paris、5601 bytes)。サイト内デプロイは
   このバイトコードにチェーンの DEX ルーター住所を付けて送るだけ。 */
const SPLIT_BYTECODE = "0x60a0604052348015600f57600080fd5b506040516115e13803806115e1833981016040819052602c916080565b6001600160a01b03811660705760405162461bcd60e51b81526020600482015260086024820152670726f757465723d360c41b604482015260640160405180910390fd5b6001600160a01b031660805260ae565b600060208284031215609157600080fd5b81516001600160a01b038116811460a757600080fd5b9392505050565b6080516114e86100f96000396000818160bc0152818161025701528181610322015281816104160152818161079101528181610ad601528181610ba10152610c9501526114e86000f3fe60806040526004361061003f5760003560e01c80632f88d6d514610044578063c5b2c8c414610077578063dbbdfd971461008a578063f887ea40146100aa575b600080fd5b34801561005057600080fd5b5061006461005f36600461107f565b6100f6565b6040519081526020015b60405180910390f35b61006461008536600461110a565b6106ba565b34801561009657600080fd5b506100646100a5366004611182565b6109df565b3480156100b657600080fd5b506100de7f000000000000000000000000000000000000000000000000000000000000000081565b6040516001600160a01b03909116815260200161006e565b600080610104888885610e71565b6040516323b872dd60e01b8152336004820152306024820152604481018290529091506001600160a01b038a16906323b872dd906064016020604051808303816000875af115801561015a573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019061017e91906111e5565b6101c55760405162461bcd60e51b81526020600482015260136024820152721d1c985b9cd9995c919c9bdb4819985a5b1959606a1b60448201526064015b60405180910390fd5b6040516370a0823160e01b81526001600160a01b038581166004830152600091908716906370a0823190602401602060405180830381865afa15801561020f573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190610233919061120e565b905060005b8881101561056b5760405163095ea7b360e01b81526001600160a01b037f000000000000000000000000000000000000000000000000000000000000000081166004830152600060248301528c169063095ea7b3906044016020604051808303816000875af11580156102af573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906102d391906111e5565b6103115760405162461bcd60e51b815260206004820152600f60248201526e185c1c1c9bdd994c0819985a5b1959608a1b60448201526064016101bc565b8a6001600160a01b031663095ea7b37f00000000000000000000000000000000000000000000000000000000000000008c8c8581811061035357610353611227565b9050602002810190610365919061123d565b60405160e084901b6001600160e01b03191681526001600160a01b0390921660048301523560248201526044016020604051808303816000875af11580156103b1573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906103d591906111e5565b6104125760405162461bcd60e51b815260206004820152600e60248201526d185c1c1c9bdd994819985a5b195960921b60448201526064016101bc565b60007f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03166338ed17398c8c8581811061045557610455611227565b9050602002810190610467919061123d565b358d8d8681811061047a5761047a611227565b905060200281019061048c919061123d565b602001358e8e878181106104a2576104a2611227565b90506020028101906104b4919061123d565b6104c290604081019061125d565b8c8c6040518763ffffffff1660e01b81526004016104e5969594939291906112ef565b6000604051808303816000875af1158015610504573d6000803e3d6000fd5b505050506040513d6000823e601f3d908101601f1916820160405261052c9190810190611343565b9050806001825161053d9190611426565b8151811061054d5761054d611227565b602002602001015185610560919061143f565b945050600101610238565b506040516370a0823160e01b81526001600160a01b03868116600483015260009183918916906370a0823190602401602060405180830381865afa1580156105b7573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906105db919061120e565b6105e59190611426565b9050878110156106075760405162461bcd60e51b81526004016101bc90611452565b878410156106575760405162461bcd60e51b815260206004820152601760248201527f616d6f756e744f757428726f7574657229203c206d696e00000000000000000060448201526064016101bc565b604080518481526020810186905260ff8b168183015290516001600160a01b0389811692908e169133917fc9751d16e97a64a0f7f5108dc0cda1bb9a8f46aced9ecccb6d5633111a199f94919081900360600190a4505050979650505050505050565b6000806106c8888885610e71565b90508034146107125760405162461bcd60e51b81526020600482015260166024820152756d73672e76616c756520213d2073756d286c6567732960501b60448201526064016101bc565b6040516370a0823160e01b81526001600160a01b038581166004830152600091908716906370a0823190602401602060405180830381865afa15801561075c573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190610780919061120e565b905060005b888110156108e55760007f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316637ff36ab58c8c858181106107d0576107d0611227565b90506020028101906107e2919061123d565b358d8d868181106107f5576107f5611227565b9050602002810190610807919061123d565b602001358e8e8781811061081d5761081d611227565b905060200281019061082f919061123d565b61083d90604081019061125d565b8c8c6040518763ffffffff1660e01b815260040161085f95949392919061147b565b60006040518083038185885af115801561087d573d6000803e3d6000fd5b50505050506040513d6000823e601f3d908101601f191682016040526108a69190810190611343565b905080600182516108b79190611426565b815181106108c7576108c7611227565b6020026020010151856108da919061143f565b945050600101610785565b506040516370a0823160e01b81526001600160a01b038681166004830152889183918916906370a0823190602401602060405180830381865afa158015610930573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190610954919061120e565b61095e9190611426565b101561097c5760405162461bcd60e51b81526004016101bc90611452565b604080518381526020810185905260ff8a16918101919091526001600160a01b0387169060009033907fc9751d16e97a64a0f7f5108dc0cda1bb9a8f46aced9ecccb6d5633111a199f94906060015b60405180910390a450509695505050505050565b6000806109ed878785610e71565b6040516323b872dd60e01b8152336004820152306024820152604481018290529091506001600160a01b038916906323b872dd906064016020604051808303816000875af1158015610a43573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190610a6791906111e5565b610aa95760405162461bcd60e51b81526020600482015260136024820152721d1c985b9cd9995c919c9bdb4819985a5b1959606a1b60448201526064016101bc565b6001600160a01b0384163160005b87811015610dea5760405163095ea7b360e01b81526001600160a01b037f000000000000000000000000000000000000000000000000000000000000000081166004830152600060248301528b169063095ea7b3906044016020604051808303816000875af1158015610b2e573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190610b5291906111e5565b610b905760405162461bcd60e51b815260206004820152600f60248201526e185c1c1c9bdd994c0819985a5b1959608a1b60448201526064016101bc565b896001600160a01b031663095ea7b37f00000000000000000000000000000000000000000000000000000000000000008b8b85818110610bd257610bd2611227565b9050602002810190610be4919061123d565b60405160e084901b6001600160e01b03191681526001600160a01b0390921660048301523560248201526044016020604051808303816000875af1158015610c30573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190610c5491906111e5565b610c915760405162461bcd60e51b815260206004820152600e60248201526d185c1c1c9bdd994819985a5b195960921b60448201526064016101bc565b60007f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03166318cbafe58b8b85818110610cd457610cd4611227565b9050602002810190610ce6919061123d565b358c8c86818110610cf957610cf9611227565b9050602002810190610d0b919061123d565b602001358d8d87818110610d2157610d21611227565b9050602002810190610d33919061123d565b610d4190604081019061125d565b8c8c6040518763ffffffff1660e01b8152600401610d64969594939291906112ef565b6000604051808303816000875af1158015610d83573d6000803e3d6000fd5b505050506040513d6000823e601f3d908101601f19168201604052610dab9190810190611343565b90508060018251610dbc9190611426565b81518110610dcc57610dcc611227565b602002602001015185610ddf919061143f565b945050600101610ab7565b5085610e00826001600160a01b03881631611426565b1015610e1e5760405162461bcd60e51b81526004016101bc90611452565b604080518381526020810185905260ff8916918101919091526000906001600160a01b038b169033907fc9751d16e97a64a0f7f5108dc0cda1bb9a8f46aced9ecccb6d5633111a199f94906060016109cb565b600060018310801590610e85575060088311155b610ebd5760405162461bcd60e51b81526020600482015260096024820152680d8cacee640625c5c760bb1b60448201526064016101bc565b42821015610ef75760405162461bcd60e51b8152602060048201526007602482015266195e1c1a5c995960ca1b60448201526064016101bc565b60005b8381101561100f576000858583818110610f1657610f16611227565b9050602002810190610f28919061123d565b3511610f655760405162461bcd60e51b815260206004820152600c60248201526b06c656720616d6f756e743d360a41b60448201526064016101bc565b6002858583818110610f7957610f79611227565b9050602002810190610f8b919061123d565b610f9990604081019061125d565b90501015610fd65760405162461bcd60e51b815260206004820152600a6024820152693830ba34103632b71e1960b11b60448201526064016101bc565b848482818110610fe857610fe8611227565b9050602002810190610ffa919061123d565b61100590358361143f565b9150600101610efa565b509392505050565b80356001600160a01b038116811461102e57600080fd5b919050565b60008083601f84011261104557600080fd5b50813567ffffffffffffffff81111561105d57600080fd5b6020830191508360208260051b850101111561107857600080fd5b9250929050565b600080600080600080600060c0888a03121561109a57600080fd5b6110a388611017565b9650602088013567ffffffffffffffff8111156110bf57600080fd5b6110cb8a828b01611033565b909750955050604088013593506110e460608901611017565b92506110f260808901611017565b96999598509396929591949193505060a09091013590565b60008060008060008060a0878903121561112357600080fd5b863567ffffffffffffffff81111561113a57600080fd5b61114689828a01611033565b9097509550506020870135935061115f60408801611017565b925061116d60608801611017565b95989497509295919493608090920135925050565b60008060008060008060a0878903121561119b57600080fd5b6111a487611017565b9550602087013567ffffffffffffffff8111156111c057600080fd5b6111cc89828a01611033565b9096509450506040870135925061116d60608801611017565b6000602082840312156111f757600080fd5b8151801515811461120757600080fd5b9392505050565b60006020828403121561122057600080fd5b5051919050565b634e487b7160e01b600052603260045260246000fd5b60008235605e1983360301811261125357600080fd5b9190910192915050565b6000808335601e1984360301811261127457600080fd5b83018035915067ffffffffffffffff82111561128f57600080fd5b6020019150600581901b360382131561107857600080fd5b81835260208301925060008160005b848110156112e5576001600160a01b036112cf83611017565b16865260209586019591909101906001016112b6565b5093949350505050565b86815285602082015260a06040820152600061130f60a0830186886112a7565b6001600160a01b039490941660608301525060800152949350505050565b634e487b7160e01b600052604160045260246000fd5b60006020828403121561135557600080fd5b815167ffffffffffffffff81111561136c57600080fd5b8201601f8101841361137d57600080fd5b805167ffffffffffffffff8111156113975761139761132d565b8060051b604051601f19603f830116810181811067ffffffffffffffff821117156113c4576113c461132d565b6040529182526020818401810192908101878411156113e257600080fd5b6020850194505b83851015611405578451808252602095860195909350016113e9565b509695505050505050565b634e487b7160e01b600052601160045260246000fd5b8181038181111561143957611439611410565b92915050565b8082018082111561143957611439611410565b6020808252600f908201526e30b6b7bab73a27baba101e1036b4b760891b604082015260600190565b8581526080602082015260006114956080830186886112a7565b6001600160a01b039490941660408301525060600152939250505056fea264697066735822122008b013a172c041b18b85d72b603ce2cbaddc3ba563e4500a998a1121048141b964736f6c634300081a0033";

/* SplitSwap への分割実行 calldata。有効なアグリゲーター住所 (内蔵スロット
   またはブラウザ保存) が無いチェーンでは呼ばないこと。
   v7: 各レッグに「そのレッグの見積もり受取量 − スリッページ」の最低受取量
   (amountOutMin) を入れ、合計の最低量と合わせて二重に守る。 */
function buildSplitTx(chainObj, fromTok, toTok, plan, account, slippagePct, nowSec) {
  const agg = effectiveAggregator(chainObj);
  if (!agg) throw new Error("aggregator not configured for this chain");
  const legs = plan.legs.map((l) => ({ amountIn: l.amountIn, amountOutMin: applySlippageBps(l.amountOut, slippagePct), path: l.route.path }));
  const totalIn = legs.reduce((s, l) => s + l.amountIn, 0n);
  const amountOutMin = applySlippageBps(plan.totalOut, slippagePct);
  const deadline = deadline20Min(nowSec);
  const tail = encLegsTail(legs);
  let data, value = 0n, fn;
  if (fromTok.isNative) {
    fn = "swapSplitFromNative";
    data = SEL.splitFromNative + encUint(160) + encUint(amountOutMin) + encAddr(toTok.address) + encAddr(account) + encUint(deadline) + tail;
    value = totalIn;
  } else if (toTok.isNative) {
    fn = "swapSplitToNative";
    data = SEL.splitToNative + encAddr(fromTok.address) + encUint(160) + encUint(amountOutMin) + encAddr(account) + encUint(deadline) + tail;
  } else {
    fn = "swapSplit";
    data = SEL.split + encAddr(fromTok.address) + encUint(192) + encUint(amountOutMin) + encAddr(toTok.address) + encAddr(account) + encUint(deadline) + tail;
  }
  return { to: agg, data, value, amountOutMin, deadline, functionName: fn, legs, totalIn };
}
/* buildSplitTx の calldata を復号する (ハーネス/プローブの照合用。
   構築と復号が往復一致することを検証するために使う)。 */
function decodeSplitTxData(data) {
  if (!data || data.length < 10) return null;
  const sel = data.slice(0, 10).toLowerCase();
  let fn = null, headWords = 0;
  if (sel === SEL.split) { fn = "swapSplit"; headWords = 6; }
  else if (sel === SEL.splitToNative) { fn = "swapSplitToNative"; headWords = 5; }
  else if (sel === SEL.splitFromNative) { fn = "swapSplitFromNative"; headWords = 5; }
  else return null;
  const hex = data.slice(10);
  const word = (i) => hex.slice(i * 64, i * 64 + 64);
  const asUint = (i) => BigInt("0x" + word(i));
  const asAddr = (i) => "0x" + word(i).slice(-40).toLowerCase();
  const legsOff = Number(asUint(fn === "swapSplitFromNative" ? 0 : 1)) / 32; // legs offset word: swapSplit/splitToNative = 1, splitFromNative = 0
  const base = legsOff;
  const nLegs = Number(asUint(base));
  const legs = [];
  for (let i = 0; i < nLegs; i++) {
    const elem = base + 1 + Number(asUint(base + 1 + i)) / 32;
    const amountIn = asUint(elem);
    const amountOutMin = asUint(elem + 1);
    const pathOff = elem + Number(asUint(elem + 2)) / 32;
    const pathLen = Number(asUint(pathOff));
    const path = [];
    for (let j = 0; j < pathLen; j++) path.push(asAddr(pathOff + 1 + j));
    legs.push({ amountIn, amountOutMin, path });
  }
  const out = { functionName: fn, legs };
  if (fn === "swapSplit") { out.tokenIn = asAddr(0); out.amountOutMinTotal = asUint(2); out.tokenOut = asAddr(3); out.to = asAddr(4); out.deadline = asUint(5); }
  if (fn === "swapSplitToNative") { out.tokenIn = asAddr(0); out.amountOutMinTotal = asUint(2); out.to = asAddr(3); out.deadline = asUint(4); }
  if (fn === "swapSplitFromNative") { out.amountOutMinTotal = asUint(1); out.tokenOut = asAddr(2); out.to = asAddr(3); out.deadline = asUint(4); }
  return out;
}
/* SplitSwap のデプロイ tx (サイト内デプロイ用)。creation bytecode の末尾に
   コンストラクタ引数 (そのチェーンの DEX ルーター住所) を付ける通常の
   コントラクト作成 tx。to は null (作成)。 */
function buildDeployTx(chainObj) {
  return { to: null, data: SPLIT_BYTECODE + encAddr(chainObj.router), value: 0n, functionName: "deploySplitSwap", router: chainObj.router.toLowerCase() };
}

/* ---------- v3 cross-chain: light best-route quote (no split evaluation) ---------- */
async function fetchBestRoute(chainObj, fromTok, toTok, amountIn) {
  if (fromTok.address.toLowerCase() === toTok.address.toLowerCase()) return null;
  if (amountIn <= 0n) return null;
  const paths = buildCandidatePaths(chainObj, fromTok, toTok);
  const results = await quoteAmountsOutByPath(chainObj, amountIn, paths);
  let best = null;
  results.forEach((hex, i) => {
    const amounts = decodeAmountsOut(hex);
    if (!amounts || !amounts.length) return;
    const out = amounts[amounts.length - 1];
    if (out <= 0n) return;
    if (!best || out > best.amountOut) best = { path: paths[i], amounts, amountOut: out, hops: paths[i].length - 1, priceImpactPct: null };
  });
  if (!best) return null;
  try {
    const { pairOf, info } = await fetchPairs(chainObj, [best]);
    const spot = spotOutFor(best, amountIn, pairOf, info);
    if (spot !== null && spot > 0n) best.priceImpactPct = (1 - Number(best.amountOut) / Number(spot)) * 100;
  } catch (e) { /* impact optional */ }
  return best;
}

/* ---------- v5: all-routes quote (no split evaluation, impacts attachable later) ----------
   fetchBestRoute の「最良だけ」版に対して、成功した全ルートを多い順で返す。
   クロスチェーンの全体ルート列挙 (レッグのバリアント保持) に使う。 */
async function fetchRoutesOnly(chainObj, fromTok, toTok, amountIn) {
  if (fromTok.address.toLowerCase() === toTok.address.toLowerCase()) return [];
  if (amountIn <= 0n) return [];
  const paths = buildCandidatePaths(chainObj, fromTok, toTok);
  const results = await quoteAmountsOutByPath(chainObj, amountIn, paths);
  const routes = [];
  results.forEach((hex, i) => {
    const amounts = decodeAmountsOut(hex);
    if (!amounts || !amounts.length) return;
    const out = amounts[amounts.length - 1];
    if (out <= 0n) return;
    routes.push({ path: paths[i], amounts, amountOut: out, hops: paths[i].length - 1, priceImpactPct: null });
  });
  routes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
  return routes;
}
/* items: [{route, amountIn}] — ルートごとに自分の入力額で spot 比較して
   priceImpactPct を付ける (ペア情報の取得はチェーンにつき1バッチにまとめる)。 */
async function attachImpactsMulti(chainObj, items) {
  if (!items.length) return;
  try {
    const { pairOf, info } = await fetchPairs(chainObj, items.map((i) => i.route));
    for (const it of items) {
      const spot = spotOutFor(it.route, it.amountIn, pairOf, info);
      if (spot !== null && spot > 0n) it.route.priceImpactPct = (1 - Number(it.route.amountOut) / Number(spot)) * 100;
    }
  } catch (e) { /* impact is optional */ }
}

/* ---------- v3 cross-chain: bridge calls ---------- */
function bridgePairBySym(sym) { return BRIDGE_PAIRS.find((p) => p.sym === sym) || null; }
function encodeRecipient32(address) { return encAddr(address); } // bytes32 = address left-padded to 32 bytes
function buildBridgeTx(pair, srcKey, recipient, amount, nativeValue) {
  const dstDomain = srcKey === "infinite" ? 766 : 421018;
  const data = SEL.transferRemote + encUint(dstDomain) + encodeRecipient32(recipient) + encUint(amount);
  if (srcKey === "infinite") return { to: pair.br.toLowerCase(), data, value: BigInt(nativeValue || 0n), dstDomain, functionName: "transferRemote" };
  return { to: pair.ql1Router.toLowerCase(), data, value: 0n, dstDomain, functionName: "transferRemote" };
}
function decodeBridgeTxData(data) {
  if (!data || data.slice(0, 10) !== SEL.transferRemote) return null;
  const w = [];
  for (let i = 10; i + 64 <= data.length; i += 64) w.push(data.slice(i, i + 64));
  if (w.length < 3) return null;
  return { destination: Number(BigInt("0x" + w[0])), recipient: "0x" + w[1].slice(-40), amount: BigInt("0x" + w[2]) };
}
async function fetchBridgeNativeQuote(pair) {
  const c = CHAINS.infinite;
  const data = SEL.quoteNative + encUint(766) + encUint(64) + encUint(0);
  const hex = await rpcOne(c, pair.br, data);
  if (!hex || hex === "0x" || hex.length < 322) return null;
  const words = hex.slice(2).match(/.{64}/g).map((x) => BigInt("0x" + x));
  return { nativeFee: words[0], gasPayment: words[1], totalNative: words[2] };
}
async function fetchBridgeDelivered(dstChainObj, messageId) {
  const mailbox = BRIDGE_MAILBOX[dstChainObj.key];
  if (!mailbox || !messageId) return null;
  const hex = await rpcOne(dstChainObj, mailbox, SEL.mailboxDelivered + messageId.replace("0x", ""));
  return hex ? BigInt(hex) === 1n : null;
}
async function readTokenBalance(chainObj, tokenAddr, account) {
  const hex = await rpcOne(chainObj, tokenAddr, SEL.balanceOf + encAddr(account));
  return decUint(hex) || 0n;
}
function extractMessageId(receipt) {
  if (!receipt || !Array.isArray(receipt.logs)) return null;
  for (const l of receipt.logs) {
    const t0 = (l.topics && l.topics[0] || "").toLowerCase();
    if ((t0 === TOPIC_BRIDGE_INITIATED || t0 === TOPIC_DISPATCH_ID) && l.topics.length > 1) return l.topics[1].toLowerCase();
  }
  return null;
}

/* ---------- v3/v5 cross-chain: quote FULL ROUTES per bridge intermediate ----------
   v5: 中継トークンごとに「交換1のバリアント × 交換2」を組み合わせた全体ルートを
   単位として返す。各全体ルートの最終額は、そのバリアントの交換1の実出力で交換2を
   実際に見積もり直した値 (最良レッグの額の流用はしない)。
   - 交換1: 上位3パス (直接含む) を保持。出すトークン自体が中継トークンの場合は
     交換なし (直接ブリッジ) の1バリアント。
   - 交換2: 各交換1バリアントには最良パスを、交換1最良バリアントには上位3パスを組み合わせる。
   - 重複する全体パスは除去。中継ごとに最大4件、全体で最大24件
     (中継ごとの最良1件とベンチマークの全体ルートは必ず残す)。
   戻り値の各要素は v4 互換フィールド (swap1Route / swap1Out / bridgeOut /
   swap2Route / finalOut / nativeFee / vsBench*) を持ち、加えて
   leg1Path / leg2Path (アドレス配列。交換なしの側は null) を持つ。 */
const X_MAX_ROUTES_PER_T = 4, X_MAX_ROUTES_TOTAL = 24, X_LEG_VARIANTS = 3;
async function quoteCrossPlan(srcKey, fromTok, dstKey, toTok, amountIn) {
  const src = CHAINS[srcKey], dst = CHAINS[dstKey];
  /* v0.3.2: bridge pairs are quoted CONCURRENTLY (max 4 in flight)
     and ISOLATED: a transport failure inside one pair disables that
     pair (listed as a disabled candidate) instead of throwing the
     whole plan. Results are assembled in BRIDGE_PAIRS order and the
     leg-2 combinations are still built sequentially per pair, so
     for the same chain state the output is identical to the old
     sequential version — just faster and failure-tolerant. */
  const processPair = async (pair) => {
    const tSrc = tokenById(srcKey, srcKey === "infinite" ? pair.infId : pair.ql1Id);
    const tDst = tokenById(dstKey, dstKey === "infinite" ? pair.infId : pair.ql1Id);
    if (!tSrc || !tDst) return { skip: true };
    const enabledDir = srcKey === "ql1" ? pair.enabledFromQl1 : pair.enabledFromInf;
    if (!enabledDir) return { disabled: { pair, tSrc, tDst, enabled: false, reason: t("xDisabledOsak") } };
    if (srcKey === "ql1" && fromTok.id === "native" && pair.sym === "QOM") return { disabled: { pair, tSrc, tDst, enabled: false, reason: t("xDisabledWrap") } };
    try {
      // --- leg 1 variants: source -> bridge token (top distinct paths) ---
      let leg1Vars; // [{route|null, out}]
      if (fromTok.address.toLowerCase() === tSrc.address.toLowerCase()) {
        leg1Vars = [{ route: null, out: amountIn }];
      } else {
        const all = await fetchRoutesOnly(src, fromTok, tSrc, amountIn);
        if (!all.length) return { skip: true };
        leg1Vars = all.slice(0, X_LEG_VARIANTS).map((r) => ({ route: r, out: r.amountOut }));
      }
      const minT = 10n ** BigInt(tSrc.decimals);
      leg1Vars = leg1Vars.filter((v) => v.out >= minT);
      if (!leg1Vars.length) return { disabled: { pair, tSrc, tDst, enabled: false, reason: t("xTooSmall") } };
      // --- leg 2 combinations (bridge fee 0, 1:1 — verified by sampling + quoteBridge) ---
      const leg2Identity = tDst.address.toLowerCase() === toTok.address.toLowerCase();
      // leg-2 routes for every variant are fetched concurrently
      // (order preserved); combos are assembled in variant order.
      const leg2All = leg2Identity
        ? null
        : await mapLimit(leg1Vars, 3, async (v) => {
            try { return await fetchRoutesOnly(dst, tDst, toTok, v.out); } catch (e) { return []; }
          });
      const combos = new Map();
      const addCombo = (v, r2, finalOut) => {
        const key = (v.route ? v.route.path.join(",") : "-") + "|" + (r2 ? r2.path.join(",") : "-");
        if (combos.has(key)) return;
        combos.set(key, {
          pair, tSrc, tDst, enabled: true,
          swap1Route: v.route, swap1Out: v.out, bridgeOut: v.out,
          swap2Route: r2, finalOut,
          leg1Path: v.route ? v.route.path.slice() : null,
          leg2Path: r2 ? r2.path.slice() : null,
          nativeFee: 0n, vsBenchDiff: null, vsBenchPct: null, isBenchmark: false,
        });
      };
      let leg2TopForBest = null;
      for (let vi = 0; vi < leg1Vars.length; vi++) {
        const v = leg1Vars[vi];
        if (leg2Identity) { addCombo(v, null, v.out); continue; }
        const all2 = leg2All[vi];
        if (!all2.length) continue;
        if (vi === 0) leg2TopForBest = all2.slice(0, X_LEG_VARIANTS);
        addCombo(v, all2[0], all2[0].amountOut);
      }
      if (leg2TopForBest) for (let i = 1; i < leg2TopForBest.length; i++) addCombo(leg1Vars[0], leg2TopForBest[i], leg2TopForBest[i].amountOut);
      let routes = [...combos.values()];
      if (!routes.length) return { skip: true };
      routes.sort((a, b) => (b.finalOut > a.finalOut ? 1 : b.finalOut < a.finalOut ? -1 : 0));
      routes = routes.slice(0, X_MAX_ROUTES_PER_T);
      if (srcKey === "infinite") { try { const q = await fetchBridgeNativeQuote(pair); const fee = q ? q.totalNative : 0n; for (const r of routes) r.nativeFee = fee; } catch (e) { /* shown as approx */ } }
      const impactSrc = [], impactDst = [];
      for (const r of routes) {
        if (r.swap1Route) impactSrc.push({ route: r.swap1Route, amountIn });
        if (r.swap2Route) impactDst.push({ route: r.swap2Route, amountIn: r.bridgeOut });
      }
      return { entry: { pair, routes }, impactSrc, impactDst };
    } catch (e) {
      // Per-candidate isolation: this pair is out, the plan goes on.
      return { disabled: { pair, tSrc, tDst, enabled: false, reason: t("xNetError") } };
    }
  };
  const pairResults = await mapLimit(BRIDGE_PAIRS, 4, processPair);
  const disabled = [];
  const perPair = []; // [{pair, routes:[fullRoute...]}]
  const impactItems = { [srcKey]: [], [dstKey]: [] };
  for (const r of pairResults) {
    if (!r || r.skip) continue;
    if (r.disabled) { disabled.push(r.disabled); continue; }
    perPair.push(r.entry);
    impactItems[srcKey].push(...r.impactSrc);
    impactItems[dstKey].push(...r.impactDst);
  }
  /* v4 benchmark: the "obvious" route — via QOM, or bridging the source token
     itself when that is possible. The better of the two intermediates' best
     full routes is the benchmark; every full route gets its difference vs it. */
  let benchmark = null, benchmarkRoute = null;
  const considerPair = (sym, kind) => {
    const pp = perPair.find((p) => p.pair.sym === sym);
    if (!pp || !pp.routes.length) return;
    const best = pp.routes[0];
    if (!benchmark || best.finalOut > benchmark.finalOut) { benchmark = { sym, kind, finalOut: best.finalOut }; benchmarkRoute = best; }
  };
  considerPair("QOM", "qom");
  const directPP = perPair.find((p) => {
    const ts = tokenById(srcKey, srcKey === "infinite" ? p.pair.infId : p.pair.ql1Id);
    return ts && ts.address.toLowerCase() === fromTok.address.toLowerCase();
  });
  if (directPP) considerPair(directPP.pair.sym, "direct");
  if (benchmarkRoute) benchmarkRoute.isBenchmark = true;
  /* global cap: keep the best full route of every intermediate, then fill by
     output up to the cap (the benchmark route is a per-intermediate best, so
     it is always kept). */
  let all = perPair.flatMap((p) => p.routes);
  all.sort((a, b) => (b.finalOut > a.finalOut ? 1 : b.finalOut < a.finalOut ? -1 : 0));
  let kept = all;
  if (all.length > X_MAX_ROUTES_TOTAL) {
    const keepSet = new Set(perPair.map((p) => p.routes[0]));
    for (const r of all) { if (keepSet.size >= X_MAX_ROUTES_TOTAL) break; keepSet.add(r); }
    kept = all.filter((r) => keepSet.has(r));
  }
  if (benchmark) {
    for (const c of kept) {
      c.vsBenchDiff = c.finalOut - benchmark.finalOut;
      c.vsBenchPct = benchmark.finalOut > 0n ? (Number(c.vsBenchDiff) / Number(benchmark.finalOut)) * 100 : 0;
    }
  }
  /* impacts only for the routes that survive (leg routes carry their own inputs) */
  for (const key of [srcKey, dstKey]) {
    const items = impactItems[key].filter((it) =>
      kept.some((r) => (key === srcKey ? r.swap1Route : r.swap2Route) === it.route));
    if (items.length) await attachImpactsMulti(CHAINS[key], items);
  }
  const result = [...kept, ...disabled];
  result.benchmark = benchmark;
  return result;
}

/* ---------- v6/v6.1: cross-chain SPLIT evaluation across full routes ----------
   1つの取引を複数の全体ルートに割合配分する。各パートは「その全体ルートの
   保存パス」を「そのパートの金額」で実際に見積もり直す (交換1 → ブリッジ1:1 →
   交換2)。最良レッグの額を流用しない。直接ブリッジの全体ルートも候補に含む。
   v6.1 で候補と探索を拡張 (ユーザー指摘: 中継 QOM の leg1 バリアント
   USDT→FISH→QOM が分割候補から漏れていた):
   - 候補 = 全体ルートの最終額順 上位6件 + 中継ごとの最良ルート (最大8件)。
     同じ中継の異なるパス (leg1 / leg2 バリアント) も別々の候補。
   - 探索 = 候補の全ペア・全3分割・全4分割 × 10%刻み配分 (各パート10%以上)。
   v6.2 で探索を 1% 刻みに精密化 (ユーザー要望「1%刻みで最善の結果を」):
   - ステージ1a: 上記 10% グリッド (5分割まで拡張)。
   - ステージ1b: 候補プール内のペアを 1% 刻みで全探索 (99配分/ペア)。
   - ステージ2: 最良配分から山登り微調整 (ステップ 5% → 2% → 1%。
     パート間の移し替え + 未使用候補の 1% 追加 — 追加候補はプールでなく
     全体ルート一覧の全件から。パート数は最大5)。1% ムーブで改善が
     無くなったら終了する局所最適であり、数学的な大域最適の証明ではない。
   - 全ステージで (ルート, 金額) 単位の見積もりキャッシュを共有する。
   v6.4 で同一中継の扱いを変更 (ユーザー指摘: 宛先が QOM 以外だと中継 QOM
   の R1/R2 が組み合わせられない): v6.1 の「交換2が実在する中継は1パート
   まで」という禁止を廃し、同一中継・同一 leg2Path のパート群は交換2を
   合算額で1回だけ見積もり、到着額に比例配分する合算モデルに置き換えた
   (combineLeg2Groups / distributeCombinedOut)。v6.1 が潰したかった
   「同じ宛先プールを2回独立見積もりする幻の勝ち」(10B QOM の BABY
   バリアント同士 50:50 の +0.33%) は、合算により構造的に消える。
   実行フェーズは従来どおりパート個別で、見積もりモデルだけの変更。
   パート金額は pct の床割りで統一し (見積もりはキャッシュ、RPC は
   レッグごとに一括)、勝った配分だけ最後に端数を最大パートへ寄せて
   同じモデルで再計算し、パート合計 = 入力額ちょうどにする。
   plan は「最良の分割が単一ベスト全体ルートに勝ったとき」だけ立つ (正直ルール)。 */
function crossSplitPool(enabled) {
  const pool = enabled.slice(0, 6);
  for (const r of enabled) {
    if (pool.length >= 8) break;
    if (!pool.includes(r) && !pool.some((p) => p.pair.sym === r.pair.sym)) pool.push(r);
  }
  return pool;
}
const X_SPLIT_COMPS = { 2: [], 3: [], 4: [], 5: [] };
(function buildSplitComps() {
  const gen = (n, total, prefix) => {
    if (n === 1) { if (total >= 10) X_SPLIT_COMPS[prefix.length + 1].push([...prefix, total]); return; }
    for (let p = 10; p <= total - 10 * (n - 1); p += 10) gen(n - 1, total - p, [...prefix, p]);
  };
  gen(2, 100, []); gen(3, 100, []); gen(4, 100, []); gen(5, 100, []);
})();
/* ---------- v6.4: combined leg-2 quoting for shared intermediates ----------
   v6.1 では「交換2が実在する中継は1プランに1パートまで」と禁止していた
   (同じ宛先プールを2回独立に見積もると合計が上振れるため)。v6.4 では禁止
   ではなく合算見積もりに置き換える: 同一中継・同一 leg2Path のパート群は、
   交換2 を「ブリッジ到着額の合計」で1回だけ見積もり、出力を到着額に比例
   配分する (端数はグループ内最大パートへ)。これで上振れは構造的に消え、
   宛先が QOM 以外でも中継 QOM の R1/R2 のような組み合わせが使える。
   交換1 は従来どおりパートごとの独立見積もり (同一チェーン分割と同じ)。 */
function leg2GroupKey(cand) {
  return cand.leg2Path ? cand.pair.sym + "|" + cand.leg2Path.map((a) => String(a).toLowerCase()).join(",") : null;
}
/* parts: [{cand, leg1Out}] -> leg2 を共有するグループ [{key, cand, totalIn, idxs}] */
function combineLeg2Groups(parts) {
  const groups = new Map();
  parts.forEach((p, i) => {
    const key = leg2GroupKey(p.cand);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, { key, cand: p.cand, totalIn: 0n, idxs: [] });
    const g = groups.get(key);
    g.totalIn += p.leg1Out;
    g.idxs.push(i);
  });
  return [...groups.values()];
}
/* 合算見積もりの出力を到着額 (leg1Out) の比率で配分する。端数は最大パートへ。 */
function distributeCombinedOut(totalOut, leg1Outs) {
  const totalIn = leg1Outs.reduce((s, x) => s + x, 0n);
  if (totalIn <= 0n) return leg1Outs.map(() => 0n);
  const shares = leg1Outs.map((o) => (totalOut * o) / totalIn);
  const dust = totalOut - shares.reduce((s, x) => s + x, 0n);
  if (dust > 0n) {
    let mi = 0;
    for (let i = 1; i < leg1Outs.length; i++) if (leg1Outs[i] > leg1Outs[mi]) mi = i;
    shares[mi] += dust;
  }
  return shares;
}
async function requoteSplitPart(srcKey, dstKey, cand, amount) {
  let o1 = null;
  if (!cand.leg1Path) o1 = amount;
  else {
    try {
      const res = await rpcBatch(CHAINS[srcKey], [[CHAINS[srcKey].router, encodeGetAmountsOut(amount, cand.leg1Path)]]);
      const amts = decodeAmountsOut(res[0]);
      o1 = amts && amts.length ? amts[amts.length - 1] : null;
    } catch (e) { return null; } // transport failure = this part unquotable, not a crash
  }
  if (o1 == null || o1 <= 0n) return null;
  if (o1 < (10n ** BigInt(cand.tSrc.decimals))) return null;
  if (!cand.leg2Path) return { leg1Out: o1, finalOut: o1 };
  try {
    const res2 = await rpcBatch(CHAINS[dstKey], [[CHAINS[dstKey].router, encodeGetAmountsOut(o1, cand.leg2Path)]]);
    const amts2 = decodeAmountsOut(res2[0]);
    const v = amts2 && amts2.length ? amts2[amts2.length - 1] : null;
    return v != null && v > 0n ? { leg1Out: o1, finalOut: v } : null;
  } catch (e) { return null; }
}
/* ---------- v6.2/v6.4: cross-split quoter ----------
   交換1 は (候補ルート, 金額) 単位でキャッシュする。交換2 は v6.4 から
   「グループキー (中継+leg2Path) × 合算到着額」単位でキャッシュする
   (combineLeg2Groups 参照 — 同一 leg2 を共有するパートは合算で1回だけ
   見積もり、比例配分する)。探索の全ステージでキャッシュを共有し、
   1回の rpcBatch が大きくなりすぎないよう 150 件ずつに区切る。 */
function makeCrossSplitQuoter(srcKey, dstKey, candIdx) {
  const leg1Cache = new Map(); // "candIdx|amount" -> leg1Out (BigInt) | null (null = その金額では交換1不可)
  const leg2Cache = new Map(); // "groupKey|totalIn" -> combined leg2 totalOut (BigInt) | null
  const stats = { partQuotes: 0, leg2Quotes: 0, batches: 0 };
  const CHUNK = 150;
  const leg1Key = (cand, amount) => candIdx.get(cand) + "|" + amount.toString();
  async function ensureLeg1(jobs) {
    const missing = [];
    const seen = new Set();
    for (const j of jobs) {
      if (!j || j.amount == null || j.amount <= 0n) continue;
      const key = leg1Key(j.cand, j.amount);
      if (!leg1Cache.has(key) && !seen.has(key)) { seen.add(key); missing.push({ key, cand: j.cand, amount: j.amount }); }
    }
    const chunks = [];
    for (let s = 0; s < missing.length; s += CHUNK) chunks.push(missing.slice(s, s + CHUNK));
    // chunks run with bounded concurrency; a chunk whose batch fails
    // at transport level marks ONLY its own keys unquotable (null) —
    // the split search degrades, it never takes the quote down.
    await mapLimit(chunks, 4, async (chunk) => {
      stats.partQuotes += chunk.length;
      const calls = [], keys = [];
      for (const m of chunk) {
        if (!m.cand.leg1Path) leg1Cache.set(m.key, m.amount); // identity leg 1 = direct bridge
        else { keys.push(m.key); calls.push([CHAINS[srcKey].router, encodeGetAmountsOut(m.amount, m.cand.leg1Path)]); }
      }
      if (calls.length) {
        stats.batches++;
        try {
          const res = await rpcBatch(CHAINS[srcKey], calls);
          keys.forEach((key, k) => { const amts = decodeAmountsOut(res[k]); leg1Cache.set(key, amts && amts.length ? amts[amts.length - 1] : null); });
        } catch (e) {
          keys.forEach((key) => leg1Cache.set(key, null));
        }
      }
    });
  }
  async function ensureLeg2(jobs) {
    // jobs: [{key (groupKey|totalIn), path, totalIn}]
    const missing = [];
    const seen = new Set();
    for (const j of jobs) {
      if (!j || j.totalIn == null || j.totalIn <= 0n) continue;
      if (!leg2Cache.has(j.key) && !seen.has(j.key)) { seen.add(j.key); missing.push(j); }
    }
    const chunks = [];
    for (let s = 0; s < missing.length; s += CHUNK) chunks.push(missing.slice(s, s + CHUNK));
    await mapLimit(chunks, 4, async (chunk) => {
      stats.leg2Quotes += chunk.length;
      stats.batches++;
      try {
        const res = await rpcBatch(CHAINS[dstKey], chunk.map((m) => [CHAINS[dstKey].router, encodeGetAmountsOut(m.totalIn, m.path)]));
        chunk.forEach((m, k) => {
          const amts = decodeAmountsOut(res[k]);
          const v = amts && amts.length ? amts[amts.length - 1] : null;
          leg2Cache.set(m.key, v != null && v > 0n ? v : null);
        });
      } catch (e) {
        chunk.forEach((m) => leg2Cache.set(m.key, null));
      }
    });
  }
  return {
    ensureLeg1, ensureLeg2, stats,
    getLeg1: (cand, amount) => leg1Cache.get(leg1Key(cand, amount)) ?? null,
    hasLeg1: (cand, amount) => leg1Cache.has(leg1Key(cand, amount)),
    getLeg2: (key) => leg2Cache.get(key) ?? null,
    hasLeg2: (key) => leg2Cache.has(key),
  };
}
async function evaluateCrossSplit(srcKey, dstKey, amountIn, cands) {
  const enabled = (cands || []).filter((c) => c.enabled);
  const bestSingle = enabled.length ? enabled[0] : null;
  if (!bestSingle || enabled.length < 2 || amountIn <= 0n) return { evaluated: 0, best: null, plan: null, bestSingle };
  const pool = crossSplitPool(enabled);
  if (pool.length < 2) return { evaluated: 0, best: null, plan: null, bestSingle };
  const t0 = Date.now();
  const candIdx = new Map(); enabled.forEach((c, i) => candIdx.set(c, i));
  const quoter = makeCrossSplitQuoter(srcKey, dstKey, candIdx);
  const partAmount = (pct) => (amountIn * BigInt(pct)) / 100n;
  /* Batch-scorer for allocations ([{cand, pct, amountIn?}]).
     v6.4: parts sharing one leg 2 (same intermediate + same leg2Path) get ONE
     combined leg-2 quote on their summed bridge arrival, distributed back
     pro-rata (see combineLeg2Groups). Leg 1 stays per-part independent.
     A part whose leg-1 output is missing or below the bridge minimum makes
     the whole allocation unusable (null), as before. */
  const scoreAllocations = async (allocs) => {
    const partLists = allocs.map((a) => a.map((l) => ({
      cand: l.cand, pct: l.pct, amountIn: l.amountIn != null ? l.amountIn : partAmount(l.pct),
    })));
    await quoter.ensureLeg1(partLists.flat().map((p) => ({ cand: p.cand, amount: p.amountIn })));
    const resolved = partLists.map((parts) => {
      const items = [];
      for (const p of parts) {
        if (p.amountIn <= 0n) return null;
        const o1 = quoter.getLeg1(p.cand, p.amountIn);
        if (o1 == null || o1 <= 0n || o1 < (10n ** BigInt(p.cand.tSrc.decimals))) return null;
        items.push({ cand: p.cand, pct: p.pct, amountIn: p.amountIn, leg1Out: o1 });
      }
      return items;
    });
    const leg2Jobs = new Map();
    for (const items of resolved) {
      if (!items) continue;
      for (const g of combineLeg2Groups(items)) {
        const key = g.key + "|" + g.totalIn.toString();
        if (!quoter.hasLeg2(key)) leg2Jobs.set(key, { key, path: g.cand.leg2Path, totalIn: g.totalIn });
      }
    }
    await quoter.ensureLeg2([...leg2Jobs.values()]);
    return resolved.map((items) => {
      if (!items) return null;
      const parts = items.map((p) => ({ cand: p.cand, pct: p.pct, amountIn: p.amountIn, leg1Out: p.leg1Out, finalOut: p.leg1Out }));
      for (const g of combineLeg2Groups(items)) {
        const tot = quoter.getLeg2(g.key + "|" + g.totalIn.toString());
        if (tot == null || tot <= 0n) return null;
        const shares = distributeCombinedOut(tot, g.idxs.map((i) => items[i].leg1Out));
        g.idxs.forEach((pi, k) => { parts[pi].finalOut = shares[k]; });
      }
      let total = 0n;
      for (const p of parts) {
        if (p.finalOut == null || p.finalOut <= 0n) return null;
        total += p.finalOut;
      }
      return { parts, totalOut: total };
    });
  };
  let evaluated = 0;
  let best = null;
  const considerAll = async (allocs) => {
    if (!allocs.length) return;
    const scores = await scoreAllocations(allocs);
    allocs.forEach((a, i) => {
      evaluated++;
      const s = scores[i];
      if (s && (!best || s.totalOut > best.totalOut)) best = s;
    });
  };
  // ---- stage 1a: 10% grid over the pool (2..5 parts, each >= 10%) ----
  const combosOf = (n) => {
    const out = [];
    const rec = (start, picked) => {
      if (picked.length === n) { out.push(picked.slice()); return; }
      for (let i = start; i <= pool.length - (n - picked.length); i++) { picked.push(i); rec(i + 1, picked); picked.pop(); }
    };
    rec(0, []);
    return out;
  };
  const gridAllocs = [];
  for (const n of [2, 3, 4, 5]) {
    if (pool.length < n) break;
    for (const idxs of combosOf(n)) {
      const routes = idxs.map((i) => pool[i]);
      for (const comp of X_SPLIT_COMPS[n]) {
        gridAllocs.push(routes.map((cand, k) => ({ cand, pct: comp[k] })));
      }
    }
  }
  await considerAll(gridAllocs);
  // ---- stage 1b: pairs brute-forced at 1% steps over the top-5 pool routes
  // (quote-count control; stage 2 can still add/grow any other route) ----
  const pairPool = pool.slice(0, 5);
  const pairAllocs = [];
  for (let i = 0; i < pairPool.length; i++) for (let j = i + 1; j < pairPool.length; j++) {
    for (let p = 1; p <= 99; p++) pairAllocs.push([{ cand: pairPool[i], pct: p }, { cand: pairPool[j], pct: 100 - p }]);
  }
  await considerAll(pairAllocs);
  // ---- stage 2 (v6.2): hill-climb refinement 5% -> 2% -> 1%. Adds may come
  // from ANY enabled full route (not just the pool), plans may reach 5 parts.
  // Scoring goes through scoreAllocations, so the v6.4 combined leg-2 rule
  // applies to every refinement move as well.
  let refineInfo = { iterations: 0, evaluatedMoves: 0 };
  if (best) {
    const refined = await refineSplitAllocation(
      best.parts.map((p) => ({ cand: p.cand, pct: p.pct })), best, scoreAllocations,
      { addCandidates: enabled, maxParts: 5, keyOf: (c) => candIdx.get(c), maxIterations: 150, budget: () => quoter.stats.partQuotes + quoter.stats.leg2Quotes < 8000 });
    refineInfo = { iterations: refined.iterations, evaluatedMoves: refined.evaluatedMoves };
    evaluated += refined.evaluatedMoves;
    if (refined.score && refined.score.totalOut > best.totalOut) best = refined.score;
  }
  if (best) {
    // display order: largest part first; then fold the floor-rounding dust
    // into the largest part and re-score the whole plan under the same
    // (combined leg-2) model, so the parts sum to exactly amountIn without
    // overstating any part's quote.
    best.parts.sort((a, b) => b.pct - a.pct);
    const dust = amountIn - best.parts.reduce((s, p) => s + p.amountIn, 0n);
    if (dust > 0n) {
      const adjusted = best.parts.map((p, i) => ({ cand: p.cand, pct: p.pct, amountIn: i === 0 ? p.amountIn + dust : p.amountIn }));
      const rescored = (await scoreAllocations([adjusted]))[0];
      if (rescored) best = rescored;
    }
  }
  const plan = best && best.totalOut > bestSingle.finalOut ? best : null;
  return { evaluated, best, plan, bestSingle, refineStats: { partQuotes: quoter.stats.partQuotes, leg2Quotes: quoter.stats.leg2Quotes, batches: quoter.stats.batches, iterations: refineInfo.iterations, ms: Date.now() - t0 } };
}

/* ---------- v6.5: net-of-fees verdict for a cross-chain split plan ----------
   ユーザー決定 (2026-11-06): クロスチェーン分割プランは「追加のブリッジ
   メッセージ代を引いても単一ベストに勝つときだけ」カードとして出す。
   - 追加代 = プランの全パートの nativeFee 合計 − 単一ベスト全体ルートの
     nativeFee。quoteNative がペアごとに等しい場合は (パート数 − 1) ×
     quoteNative と一致する。QL1 発は実測で全パート 0 なので追加代は 0。
   - 換算はこのサイト自身の見積もり機構だけを使う: [42] の追加代を
     Infinite の最良ルートで QOM に替え (fetchBestRoute)、その QOM は
     ブリッジ 1:1 で QL1 の QOM になるので、宛先トークンが QOM 以外なら
     QL1 の最良ルートでもう一度替える。裁定ボードの手数料換算と同じ考え方。
   - 換算できなかった場合は、安全側でプランを出さない (convFailed)。
   DEX ガスは従来どおり含めない (カードにも明示する)。 */
async function evaluateCrossSplitNet(srcKey, dstKey, toTok, xs) {
  if (!xs || !xs.plan || !xs.bestSingle || !toTok) return null;
  const gain = xs.plan.totalOut - xs.bestSingle.finalOut;
  const planFee = xs.plan.parts.reduce((s, p) => s + (p.cand.nativeFee || 0n), 0n);
  const singleFee = xs.bestSingle.nativeFee || 0n;
  const extraFeeNative = planFee > singleFee ? planFee - singleFee : 0n;
  const pctOf = (net) => xs.bestSingle.finalOut > 0n ? (Number(net) / Number(xs.bestSingle.finalOut)) * 100 : 0;
  if (extraFeeNative <= 0n) return { shown: true, gain, extraFeeNative, extraFeeDest: 0n, netGain: gain, netPct: pctOf(gain), convFailed: false };
  let extraFeeDest = null;
  try {
    const conv1 = await fetchBestRoute(CHAINS.infinite, tokenById("infinite", "native"), tokenById("infinite", "qom"), extraFeeNative);
    if (conv1 && conv1.amountOut > 0n) {
      if (toTok.id === "native" || toTok.id === "wqom") {
        extraFeeDest = conv1.amountOut; // QOM bridges 1:1, so Infinite-side QOM == QL1-side QOM amount
      } else {
        const conv2 = await fetchBestRoute(CHAINS.ql1, tokenById("ql1", "wqom"), toTok, conv1.amountOut);
        if (conv2 && conv2.amountOut > 0n) extraFeeDest = conv2.amountOut;
      }
    }
  } catch (e) { extraFeeDest = null; }
  if (extraFeeDest == null) return { shown: false, gain, extraFeeNative, extraFeeDest: null, netGain: null, netPct: null, convFailed: true };
  const netGain = gain - extraFeeDest;
  return { shown: netGain > 0n, gain, extraFeeNative, extraFeeDest, netGain, netPct: pctOf(netGain), convFailed: false };
}

/* ---------- v6: split-flow arrival attribution (pure; harness-tested) ----------
   同じ中継トークンのパートが複数ある場合、到着分はパートの順番どおりに
   「そのパートがブリッジした見込み量」まで割り当てる。最後のパートだけは、
   合計が見込み合計 (許容誤差内) に達した時点で実際の残り全部を受け取る
   (過剰配達や端数が宙に浮かないように)。
   parts: [{sym, bridgedAmount(string|null), arrivedAmt, arrivedFlag}]
   arrivedBySym: {sym: BigInt (基準残高を引いた到着合計)} */
function attributeSplitArrivals(parts, arrivedBySym) {
  const groups = new Map();
  for (const p of parts) {
    if (p.bridgedAmount == null) continue;
    if (!groups.has(p.sym)) groups.set(p.sym, []);
    groups.get(p.sym).push(p);
  }
  for (const [sym, group] of groups) {
    let remaining = BigInt(arrivedBySym[sym] != null ? arrivedBySym[sym] : "0");
    if (remaining < 0n) remaining = 0n;
    const totalBridged = group.reduce((s, p) => s + BigInt(p.bridgedAmount), 0n);
    const covered = remaining > 0n && remaining >= totalBridged - (totalBridged / 1000n + 1n);
    group.forEach((p, i) => {
      const bridged = BigInt(p.bridgedAmount);
      const isLast = i === group.length - 1;
      let attributed = isLast && covered ? remaining : (remaining < bridged ? remaining : bridged);
      if (attributed < 0n) attributed = 0n;
      remaining -= attributed; if (remaining < 0n) remaining = 0n;
      p.arrivedAmt = attributed.toString();
      p.arrivedFlag = attributed > 0n && attributed >= bridged - (bridged / 1000n + 1n);
    });
  }
}
/* split flow の現在フェーズ (パートの最小未完ステップから導出。永続化しない) */
function crossSplitPhase(f) {
  if (!f || !Array.isArray(f.parts) || !f.parts.length) return "done";
  if (f.parts.every((p) => p.step === 4 || p.step === "error")) return "done";
  if (f.parts.some((p) => p.step === 0)) return 1;
  if (f.parts.some((p) => p.step === 1)) return 2;
  if (f.parts.some((p) => p.step === 2)) return 3;
  return 4;
}

export {
  CHAINS, BRIDGE_PAIRS, BRIDGE_MAILBOX, SEL as AGG_SEL, NATIVE_PH, WQOM,
  tokenById, tokenByAddress, symbolFor, allTokens,
  parseAmount, formatAmount,
  fetchQuotesForTokens, fetchBestRoute, fetchRoutesOnly,
  quoteCrossPlan, evaluateCrossSplit, evaluateCrossSplitNet,
  buildSwapTx, buildApproveTx, buildBridgeTx, buildSplitTx,
  requoteSplitPart,
  fetchBridgeNativeQuote, fetchBridgeDelivered, readTokenBalance,
  extractMessageId, attributeSplitArrivals, crossSplitPhase,
  applySlippageBps, deadline20Min, encAddr, encUint,
};
