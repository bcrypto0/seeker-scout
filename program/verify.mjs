// Re-verify the pinned SKR staking program facts with Node 18+ built-ins only (no packages).
// Read-only: two getAccountInfo calls on the public RPC. Exit code 0 = unchanged, 1 = drift.
// Usage (repo root): node program/verify.mjs program/idl.json
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const RPC = 'https://api.mainnet-beta.solana.com';
const IDL_ACCOUNT = '4aAEUKCcju9iAEAgdeaNz4RC7sCPv63q5g714nw4QY68';
const PROGRAM_DATA = '7f1KoiGPFFouvAafZtVmtdpgGJuADprihB9Pdzut3gaJ';
const PINNED_DEPLOY_SLOT = 393714625n;
const PINNED_IDL_SHA256 = '6b5086f57a412d07ee5d9c839a7fc8723f592cc2bbc7771573133e68b411c843';

async function getAccount(address, extra = {}) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [address, { encoding: 'base64', commitment: 'confirmed', ...extra }] }),
  });
  const j = await res.json();
  if (j.error || !j.result?.value) throw new Error(`getAccountInfo ${address}: ${JSON.stringify(j.error ?? 'missing')}`);
  return { slot: j.result.context.slot, owner: j.result.value.owner, data: Buffer.from(j.result.value.data[0], 'base64') };
}

// 1. ProgramData header: u32 tag (3), u64 LE deploy slot at offset 4, Option<Pubkey> authority.
const pd = await getAccount(PROGRAM_DATA, { dataSlice: { offset: 0, length: 45 } });
const deploySlot = pd.data.readBigUInt64LE(4);

// 2. Anchor IDL account: 8 disc, 32 authority, u32 LE data_len at 40, zlib payload from 44.
const idl = await getAccount(IDL_ACCOUNT);
const len = idl.data.readUInt32LE(40);
const json = inflateSync(idl.data.subarray(44, 44 + len));
const sha = createHash('sha256').update(json).digest('hex');

let ok = deploySlot === PINNED_DEPLOY_SLOT && sha === PINNED_IDL_SHA256;
console.log(`read at slot ${idl.slot}`);
console.log(`deploy slot  ${deploySlot}  ${deploySlot === PINNED_DEPLOY_SLOT ? 'OK' : 'CHANGED (pinned ' + PINNED_DEPLOY_SLOT + ')'}`);
console.log(`idl sha256   ${sha}  ${sha === PINNED_IDL_SHA256 ? 'OK' : 'CHANGED'}  (${json.length} bytes inflated, ${len} compressed)`);
if (process.argv[2]) {
  const local = createHash('sha256').update(readFileSync(process.argv[2])).digest('hex');
  console.log(`local file   ${local}  ${local === PINNED_IDL_SHA256 ? 'OK' : 'DIFFERS'}`);
  ok = ok && local === PINNED_IDL_SHA256;
}
// exitCode, not process.exit(): exiting while fetch's socket is still closing trips a libuv
// assertion on Windows (seen 2026-09-30, exit 127 instead of 0).
process.exitCode = ok ? 0 : 1;
