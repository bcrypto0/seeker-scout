// src/lib/skr.parity.test.ts: `npm run test:app`. The phone's stake read against the
// LIVE worker's own files (lounge-worker/src/skr.js and vouch-lib.js, imported as is):
// the same UserStake PDA and bump for the fixture wallets and a seeded set of random
// keys, the same read (status, reason, amounts, cooldown, weight, per-pool rows) for
// the same getMultipleAccounts reply, and the same weight curve. A difference here is
// a Profile card that disagrees with the weight a signed vouch gets.
// The worker is driven through its real readStakeMany with a fetch shim (no DB, no
// network); the app through its real readStakeOnce with the same shim.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import * as app from './skr.ts';
import type { StakeRead } from './skr.ts';
import * as worker from '../../lounge-worker/src/skr.js';
import { weightFor as workerWeightFor } from '../../lounge-worker/src/vouch-lib.js';

const fx = JSON.parse(readFileSync(fileURLToPath(new URL('../../lounge-worker/test/fixtures/skr_fixtures.json', import.meta.url).href), 'utf8'));
const X = fx.expected;
const SYSTEM = '11111111111111111111111111111111';
const W = X.sampleUserStake.user as string;
const MISSING = fx.accounts.missingUserStake.user as string;

/** mulberry32: small, seeded, the same keys on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Acc = { owner: string; lamports: number; dataBase64: string };
const info = (a: Acc) => ({ owner: a.owner, lamports: a.lamports, data: [a.dataBase64, 'base64'], executable: false, rentEpoch: 0 });
const edited = (a: Acc, edit: (b: Uint8Array) => void) => {
  const b = new Uint8Array(Buffer.from(a.dataBase64, 'base64'));
  edit(b);
  return { ...info(a), data: [Buffer.from(b).toString('base64'), 'base64'] };
};
const byAddr = new Map<string, unknown>([
  [fx.accounts.stakeConfig.address, info(fx.accounts.stakeConfig)],
  [fx.accounts.sampleUserStake.address, info(fx.accounts.sampleUserStake)],
  ...fx.accounts.userStakes.map((a: Acc & { address: string }) => [a.address, info(a)] as [string, unknown]),
]);
const cfg = fx.accounts.stakeConfig as Acc;
const sample = fx.accounts.sampleUserStake as Acc;
/** The same bytes with non-zero padding bits: the last data character one step past canonical. */
const loosePad = (s: string) => {
  const at = s.length - (s.endsWith('==') ? 2 : 1) - 1;
  assert.ok(s.endsWith('='), 'a padded account');
  return `${s.slice(0, at)}${String.fromCharCode(s.charCodeAt(at) + 1)}${s.slice(at + 1)}`;
};

/** A reply as a function of the addresses asked for, so both sides get byte-identical answers. */
type Scenario = { label: string; wallet: string; result: (addresses: string[]) => unknown };
const served = (over: (v: unknown[]) => unknown[] = (v) => v) => (addresses: string[]) => ({
  context: { slot: fx.slot },
  value: over(addresses.map((a) => byAddr.get(a) ?? null)),
});
const SCENARIOS: Scenario[] = [
  { label: 'sample', wallet: W, result: served() },
  ...X.userStakes.map((x: any) => ({ label: x.label, wallet: x.user, result: served() })),
  { label: 'no position', wallet: MISSING, result: served() },
  { label: 'lamports sent to the PDA', wallet: MISSING, result: served((v) => [v[0], { owner: SYSTEM, lamports: 890880, data: ['', 'base64'], executable: false, rentEpoch: 0 }]) },
  { label: 'system account with data', wallet: MISSING, result: served((v) => [v[0], { owner: SYSTEM, lamports: 1, data: ['QQ==', 'base64'] }]) },
  { label: 'short reply', wallet: W, result: served((v) => [v[0]]) },
  { label: 'long reply', wallet: W, result: served((v) => [...v, null]) },
  { label: 'value null', wallet: W, result: () => ({ context: { slot: 1 }, value: null }) },
  { label: 'no result', wallet: W, result: () => undefined },
  { label: 'no slot', wallet: W, result: (a) => ({ value: served()(a).value }) },
  { label: 'no config', wallet: W, result: served((v) => [null, v[1]]) },
  { label: 'config owner', wallet: W, result: served((v) => [{ ...info(cfg), owner: SYSTEM }, v[1]]) },
  { label: 'config mint', wallet: W, result: served((v) => [edited(cfg, (b) => { b[41] ^= 1; }), v[1]]) },
  { label: 'config vault', wallet: W, result: served((v) => [edited(cfg, (b) => { b[73] ^= 1; }), v[1]]) },
  { label: 'config share price 0', wallet: W, result: served((v) => [edited(cfg, (b) => b.fill(0, 137, 153)), v[1]]) },
  { label: 'config cooldown 0', wallet: W, result: served((v) => [edited(cfg, (b) => b.fill(0, 113, 121)), v[1]]) },
  { label: 'config discriminator', wallet: W, result: served((v) => [edited(cfg, (b) => { b[3] ^= 1; }), v[1]]) },
  { label: 'config cut', wallet: W, result: served((v) => [{ ...info(cfg), data: [cfg.dataBase64.slice(0, 100), 'base64'] }, v[1]]) },
  { label: 'config not base64', wallet: W, result: served((v) => [{ ...info(cfg), data: ['!!!!', 'base64'] }, v[1]]) },
  { label: 'another wallet\'s position', wallet: MISSING, result: served((v) => [v[0], info(sample)]) },
  { label: 'position bump', wallet: W, result: served((v) => [v[0], edited(sample, (b) => { b[8] ^= 1; })]) },
  { label: 'position config key', wallet: W, result: served((v) => [v[0], edited(sample, (b) => { b[9] ^= 1; })]) },
  { label: 'position wallet key', wallet: W, result: served((v) => [v[0], edited(sample, (b) => { b[41] ^= 1; })]) },
  { label: 'position pool key', wallet: W, result: served((v) => [v[0], edited(sample, (b) => { b[73] ^= 1; })]) },
  { label: 'position discriminator', wallet: W, result: served((v) => [v[0], edited(sample, (b) => { b[7] ^= 1; })]) },
  { label: 'position owner', wallet: W, result: served((v) => [v[0], { ...info(sample), owner: SYSTEM }]) },
  { label: 'position cut', wallet: W, result: served((v) => [v[0], { ...info(sample), data: [sample.dataBase64.slice(0, -4), 'base64'] }]) },
  { label: 'position data a string', wallet: W, result: served((v) => [v[0], { ...info(sample), data: 'abc' }]) },
  // Non-zero padding bits: @scure/base on the worker refuses them, so the app must too.
  { label: 'position QR==', wallet: W, result: served((v) => [v[0], { ...info(sample), data: ['QR==', 'base64'] }]) },
  { label: 'position QUJ=', wallet: W, result: served((v) => [v[0], { ...info(sample), data: ['QUJ=', 'base64'] }]) },
  { label: 'position loose padding', wallet: W, result: served((v) => [v[0], { ...info(sample), data: [loosePad(sample.dataBase64), 'base64'] }]) },
  { label: 'config loose padding', wallet: W, result: served((v) => [{ ...info(cfg), data: [loosePad(cfg.dataBase64), 'base64'] }, v[1]]) },
  { label: 'position false', wallet: W, result: served((v) => [v[0], false]) },
  { label: 'position 0', wallet: W, result: served((v) => [v[0], 0]) },
  // Unstaking with a huge amount and a later timestamp: the arithmetic, not only the fixture's values.
  { label: 'large unstake', wallet: W, result: served((v) => [v[0], edited(sample, (b) => { b.fill(255, 153, 161); b[168] = 0; b.fill(1, 161, 168); })]) },
];

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

/** Both sides' reads over one scenario. The worker reads through its own rpc.js and globalThis.fetch. */
async function both(s: Scenario): Promise<{ a: StakeRead; w: any }> {
  const shim = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.method, 'getMultipleAccounts');
    assert.deepEqual(body.params[1], { encoding: 'base64', commitment: 'confirmed' });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: s.result(body.params[0]) }));
  };
  globalThis.fetch = shim as typeof fetch;
  const w = (await worker.readStakeMany({ RPC_URL: 'http://fake.invalid/redacted' }, [s.wallet])).get(s.wallet);
  const a = await app.readStakeOnce({ rpcUrl: 'http://fake.invalid/redacted', fetch: shim, now: () => 0 }, s.wallet);
  return { a, w };
}
const FIELDS = ['status', 'reason', 'slot', 'sharePrice', 'cooldownSeconds', 'minStakeAmount', 'stakedRaw', 'unstakingRaw',
  'unstakeTimestamp', 'withdrawableAt', 'stakedSkr', 'unstakingSkr', 'weight', 'pools'] as const;
const pick = (r: any) => Object.fromEntries(FIELDS.map((k) => [k, r?.[k]]));

test('PDA: the app (web3.js) and the worker (noble, no web3.js) derive the same address and bump', () => {
  const pool = new PublicKey(app.GUARDIAN_POOLS[0]).toBytes();
  const r = rng(0x5eec5);
  const wallets = [W, MISSING, ...X.userStakes.map((x: any) => x.user)];
  for (let i = 0; i < 400; i++) wallets.push(new PublicKey(Uint8Array.from({ length: 32 }, () => Math.floor(r() * 256))).toBase58());
  wallets.push(new PublicKey(new Uint8Array(32)).toBase58(), new PublicKey(new Uint8Array(32).fill(255)).toBase58());
  const bumps = new Set<number>();
  for (const w of wallets) {
    const got = app.userStakePda(w);
    const want = worker.userStakePda(new PublicKey(w).toBytes(), pool);
    assert.deepEqual(got, { pda: new PublicKey(want.address).toBase58(), bump: want.bump }, w);
    bumps.add(got.bump);
  }
  assert.ok(bumps.size >= 3, `bumps seen: ${[...bumps]}`); // the search below 255 is exercised, not only the first try
});

test('same reply, same read: every fixture wallet and every way the reply can be wrong', async () => {
  for (const s of SCENARIOS) {
    const { a, w } = await both(s);
    assert.ok(w, s.label);
    assert.deepEqual(pick(a), pick(w), s.label);
  }
  // The fixture wallets really are the happy path on both sides.
  const oks = [];
  for (const s of SCENARIOS.slice(0, 1 + X.userStakes.length)) oks.push((await both(s)).a.status);
  assert.deepEqual(oks, Array(1 + X.userStakes.length).fill('ok'));
});

test('transport failures are "unknown" on both sides, and neither side keeps provider text', async () => {
  const cases: Array<[string, () => Response]> = [
    ['rpc error', () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'http://leak.example/key down' } }))],
    ['403', () => new Response('no', { status: 403 })],
  ];
  for (const [label, make] of cases) {
    const shim = async () => make();
    globalThis.fetch = shim as typeof fetch;
    const w = (await worker.readStakeMany({ RPC_URL: 'http://fake.invalid/redacted' }, [W])).get(W);
    const a = await app.readStakeOnce({ rpcUrl: 'http://fake.invalid/redacted', fetch: shim }, W);
    assert.deepEqual([a.status, a.reason, a.stakedSkr, a.weight], [w.status, w.reason, w.stakedSkr, w.weight], label);
    assert.ok(!String(a.reason).includes('leak') && !String(w.reason).includes('leak'), label);
  }
});

test('weightFor: the app and the worker agree on a seeded sweep and the edges', () => {
  const r = rng(0x5eec6);
  const values: unknown[] = [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '100', 1e-9, 0.5,
    99.999, 100, 1000, 9176.231936, 99_899, 99_900, 99_900.0001, 1e12];
  for (let i = 0; i < 20_000; i++) values.push(r() * 10 ** (r() * 7));
  for (const x of fx.expected.userStakes) values.push(x.stakedSkr);
  for (const v of values) assert.equal(app.weightFor(v as number), workerWeightFor(v), String(v));
});
