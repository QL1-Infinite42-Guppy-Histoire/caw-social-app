/**
 * HuntersExchange order verification — the cryptographic and
 * on-chain checks the order server runs before accepting a
 * listing. The server holds NO keys and can never move funds;
 * these checks exist so the displayed book is not polluted
 * with orders that could never fill.
 */
import {
  TypedDataEncoder,
  verifyTypedData,
  verifyMessage,
  getBytes,
  id as keccakId,
} from 'ethers';

export const ORDER_TYPES = {
  Order: [
    { name: 'maker', type: 'address' },
    { name: 'tokenGive', type: 'address' },
    { name: 'amountGive', type: 'uint256' },
    { name: 'tokenGet', type: 'address' },
    { name: 'amountGet', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};

export function domainFor(contract) {
  return {
    name: 'HuntersExchange',
    version: '1',
    chainId: 421018,
    verifyingContract: contract,
  };
}

function orderValue(o) {
  return {
    maker: o.maker,
    tokenGive: o.tokenGive,
    amountGive: BigInt(o.amountGive),
    tokenGet: o.tokenGet,
    amountGet: BigInt(o.amountGet),
    expiry: BigInt(o.expiry),
    nonce: BigInt(o.nonce),
  };
}

export function orderHash(contract, o) {
  return TypedDataEncoder.hash(domainFor(contract), ORDER_TYPES, orderValue(o));
}

/** True when `signature` is the maker's EIP-712 signature of the order. */
export function verifyOrderSignature(contract, o, signature) {
  try {
    // ethers v6: verifyTypedData (TypedDataEncoder has no
    // recover() in v6 — using it would silently refuse every
    // order, which scripts/verify-exchange.mjs now pins).
    const recovered = verifyTypedData(
      domainFor(contract),
      ORDER_TYPES,
      orderValue(o),
      signature,
    );
    return recovered.toLowerCase() === String(o.maker).toLowerCase();
  } catch {
    return false;
  }
}

/** True when `signature` is the maker's personal-sign of the order hash (cancel auth). */
export function verifyCancelSignature(contract, o, signature) {
  try {
    const recovered = verifyMessage(
      getBytes(orderHash(contract, o)),
      signature,
    );
    return recovered.toLowerCase() === String(o.maker).toLowerCase();
  } catch {
    return false;
  }
}

const RPC42 = 'https://evm-rpc.infinitedrive.xyz';

function padAddr(a) {
  return String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

/**
 * The maker's escrowed balance of `token` in the exchange
 * contract, read straight from 42 Chain. Returns a bigint,
 * or null when the read fails (the caller then refuses the
 * listing — an unverifiable order is not listed).
 */
export async function escrowBalanceOf(contract, token, maker, fetchImpl) {
  const data =
    keccakId('balanceOf(address,address)').slice(0, 10) +
    padAddr(token) +
    padAddr(maker);
  try {
    const res = await (fetchImpl || fetch)(RPC42, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: contract, data }, 'latest'],
      }),
    });
    const j = await res.json();
    if (!j || !j.result) return null;
    return BigInt(j.result);
  } catch {
    return null;
  }
}

/** On-chain filled amount for an order hash; null on read failure. */
export async function filledOf(contract, hash, fetchImpl) {
  const data =
    keccakId('filled(bytes32)').slice(0, 10) +
    String(hash).replace(/^0x/, '').padStart(64, '0');
  try {
    const res = await (fetchImpl || fetch)(RPC42, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: contract, data }, 'latest'],
      }),
    });
    const j = await res.json();
    if (!j || !j.result) return null;
    return BigInt(j.result);
  } catch {
    return null;
  }
}
