'use strict';

const BTC_TREASURY = process.env.BTC_DEPOSIT_ADDRESS;
const ETH_TREASURY = (process.env.ETH_DEPOSIT_ADDRESS || '').toLowerCase();
const SOL_TREASURY = process.env.SOL_DEPOSIT_ADDRESS;

async function safeFetch(url, opts = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

/* ── BTC via Blockstream.info (no API key needed) ── */
async function verifyBTC(txHash) {
  try {
    const [txRes, tipRes] = await Promise.all([
      safeFetch(`https://blockstream.info/api/tx/${txHash}`),
      safeFetch('https://blockstream.info/api/blocks/tip/height'),
    ]);
    if (!txRes.ok) return null;
    const tx = await txRes.json();
    const tipText = tipRes.ok ? await tipRes.text() : '0';
    const tipHeight = parseInt(tipText.trim(), 10) || 0;

    const output = (tx.vout || []).find(o => o.scriptpubkey_address === BTC_TREASURY);
    if (!output) return { error: 'No output to treasury address in this transaction' };

    const satoshis = output.value || 0;
    const btcAmount = satoshis / 1e8;
    const confirmed = tx.status?.confirmed === true;
    const blockHeight = tx.status?.block_height || 0;
    const confirmations = confirmed && tipHeight > 0 ? Math.max(0, tipHeight - blockHeight + 1) : 0;

    return { coin: 'BTC', amount: btcAmount, confirmations, confirmed: confirmations >= 2 };
  } catch (e) {
    console.error('[blockchain:btc]', e.message);
    return null;
  }
}

/* ── ETH via Cloudflare public RPC ── */
async function verifyETH(txHash) {
  async function rpc(method, params) {
    const r = await safeFetch('https://cloudflare-eth.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return r.json();
  }

  try {
    const [txData, receiptData, blockData] = await Promise.all([
      rpc('eth_getTransactionByHash', [txHash]),
      rpc('eth_getTransactionReceipt', [txHash]),
      rpc('eth_blockNumber', []),
    ]);

    const tx = txData?.result;
    if (!tx) return null;
    if ((tx.to || '').toLowerCase() !== ETH_TREASURY) {
      return { error: 'Recipient is not the treasury address' };
    }

    const receipt = receiptData?.result;
    if (receipt && receipt.status !== '0x1') {
      return { error: 'Transaction was reverted on-chain' };
    }

    const wei = BigInt(tx.value || '0x0');
    const ethAmount = Number(wei) / 1e18;
    const currentBlock = parseInt(blockData?.result || '0x0', 16);
    const txBlock = parseInt(tx.blockNumber || '0x0', 16);
    const confirmations = txBlock > 0 ? Math.max(0, currentBlock - txBlock + 1) : 0;

    return { coin: 'ETH', amount: ethAmount, confirmations, confirmed: confirmations >= 12 };
  } catch (e) {
    console.error('[blockchain:eth]', e.message);
    return null;
  }
}

/* ── SOL via Solana public RPC ── */
async function verifySOL(signature) {
  async function rpc(method, params) {
    const r = await safeFetch('https://api.mainnet-beta.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return r.json();
  }

  try {
    const txData = await rpc('getTransaction', [
      signature,
      { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 },
    ]);

    const tx = txData?.result;
    if (!tx) return null;

    const accounts = tx.transaction?.message?.accountKeys || [];
    const preBalances = tx.meta?.preBalances || [];
    const postBalances = tx.meta?.postBalances || [];

    const treasuryIdx = accounts.findIndex(a =>
      (typeof a === 'string' ? a : a.pubkey) === SOL_TREASURY
    );

    if (treasuryIdx === -1) {
      return { error: 'Treasury address not found in transaction accounts' };
    }

    const lamportsDiff = (postBalances[treasuryIdx] || 0) - (preBalances[treasuryIdx] || 0);
    if (lamportsDiff <= 0) {
      return { error: 'Treasury balance did not increase in this transaction' };
    }

    const solAmount = lamportsDiff / 1e9;
    // Finalized commitment = fully confirmed on Solana
    return { coin: 'SOL', amount: solAmount, confirmations: 32, confirmed: true };
  } catch (e) {
    console.error('[blockchain:sol]', e.message);
    return null;
  }
}

module.exports = { verifyBTC, verifyETH, verifySOL };
