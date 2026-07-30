/**
 * Solana JSON-RPC helper, shared by index.js (Genesis Token checks) and
 * alpha.js (USDC payment verification). Lifted verbatim out of index.js —
 * same timeout, same retry policy, same error surface.
 */

export const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

/** JSON-RPC with timeout + 2 retries (backoff w/ jitter) on 429/5xx/network. */
export async function rpc(env, method, params) {
  const url = env.RPC_URL || DEFAULT_RPC;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) =>
        setTimeout(r, 400 * attempt + Math.random() * 300),
      );
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`rpc ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`rpc ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(`rpc: ${body.error.message}`);
      return body.result;
    } catch (e) {
      lastErr = e;
      if (e?.message?.startsWith('rpc:')) throw e; // RPC-level error: no retry
    }
  }
  throw lastErr ?? new Error('rpc unavailable');
}
