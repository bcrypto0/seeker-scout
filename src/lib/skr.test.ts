// src/lib/skr.test.ts: `npm run test:app` (node --test; Node 24 strips the types).
// The phone's SKR stake read (SPEC-skr-final 2.1, 2.2, 3): constants, the strict
// base64 decoder, the fail-closed decoders, the UserStake PDA, the reply decode,
// the JSON-RPC read against a scripted fetch, the weight curve and the card's
// sentences. Chain values come from the fixture's `expected` block (public mainnet
// accounts captured read-only 2026-09-30 at slot 451853888), never from literals of
// an older capture: share_price moves when rewards land. No network.
// Parity with the worker's own file over the same replies: skr.parity.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as skr from './skr.ts';
import type { FetchLike, StakeRead } from './skr.ts';

const fx = JSON.parse(readFileSync(fileURLToPath(new URL('../../lounge-worker/test/fixtures/skr_fixtures.json', import.meta.url).href), 'utf8'));
const X = fx.expected;
const SYSTEM = '11111111111111111111111111111111';
const W = X.sampleUserStake.user as string;              // GZaWCB..., owns 13MeAp... (bump 254)
const MISSING = fx.accounts.missingUserStake.user as string; // Hgbea5..., PDA 5ZXR98... has no account
const CAPTURED_MS = Date.parse(fx.capturedAt);
const EM_DASH = String.fromCharCode(0x2014);

type Acc = { owner: string; lamports: number; dataBase64: string };
const info = (a: Acc) => ({ owner: a.owner, lamports: a.lamports, data: [a.dataBase64, 'base64'], executable: false, rentEpoch: 0 });
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const bytesOf = (a: Acc) => new Uint8Array(Buffer.from(a.dataBase64, 'base64'));
/** An account entry with its bytes rewritten by `edit`. */
const edited = (a: Acc, edit: (b: Uint8Array) => void) => {
  const b = bytesOf(a);
  edit(b);
  return { ...info(a), data: [b64(b), 'base64'] };
};

/** Every captured account by address; the RPC answers null for anything else. */
const byAddr = new Map<string, unknown>([
  [fx.accounts.stakeConfig.address, info(fx.accounts.stakeConfig)],
  [fx.accounts.sampleUserStake.address, info(fx.accounts.sampleUserStake)],
  ...fx.accounts.userStakes.map((a: Acc & { address: string }) => [a.address, info(a)] as [string, unknown]),
]);
const reply = (addresses: string[], over: (v: unknown[]) => unknown[] = (v) => v) => ({
  context: { slot: fx.slot },
  value: over(addresses.map((a) => byAddr.get(a) ?? null)),
});
const planOf = (w: string) => {
  const p = skr.planStakeRead(w);
  assert.ok(p, w);
  return p;
};
const readOf = (w: string, over?: (v: unknown[]) => unknown[]) => {
  const plan = planOf(w);
  return skr.decodeStakeReply(plan, reply(skr.planAddresses(plan), over), CAPTURED_MS);
};
/** Every wallet in the fixture with the read the capture expects. */
const WALLETS: Array<{ user: string; label: string; x: any }> = [
  { user: W, label: 'sample', x: X.sampleUserStake },
  ...X.userStakes.map((x: any) => ({ user: x.user, label: x.label, x })),
];

// ---------------------------------------------------------------- constants and base64
test('pinned constants equal the fixture capture (program/README.md)', () => {
  assert.equal(skr.SKR_PROGRAM, fx.program.id);
  assert.equal(skr.STAKE_CONFIG, fx.accounts.stakeConfig.address);
  assert.deepEqual([...skr.GUARDIAN_POOLS], [fx.accounts.guardianPool.address]);
  assert.equal(skr.SKR_MINT, X.stakeConfig.mint);
  assert.equal(skr.STAKE_VAULT, X.stakeConfig.stakeVault);
  assert.deepEqual([skr.LEN.config, skr.LEN.user], [193, 169]);
  assert.deepEqual([...skr.DISC.config], [238, 151, 43, 3, 11, 151, 63, 176]);
  assert.deepEqual([...skr.DISC.user], [102, 53, 163, 107, 9, 138, 87, 153]);
  assert.equal(skr.SHARE_SCALE, BigInt(1e9));
  assert.equal(skr.WEIGHT_CAP, 4);
});

test('decodeBase64: the bytes Buffer gives for every length 0 to 300; refuses the alphabet, length and padding it must', () => {
  for (let n = 0; n <= 300; n++) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 151 + n * 7 + 13) & 255;
    assert.deepEqual(skr.decodeBase64(b64(bytes)), bytes, `length ${n}`);
  }
  const real = fx.accounts.sampleUserStake.dataBase64 as string;
  assert.deepEqual(skr.decodeBase64(real), bytesOf(fx.accounts.sampleUserStake));
  // Non-zero padding bits ('QR==', 'QUJ=', the real account one step off canonical) are refused, as @scure/base does.
  assert.ok(real.endsWith('=='));
  const loose = `${real.slice(0, -3)}${String.fromCharCode(real.charCodeAt(real.length - 3) + 1)}==`;
  for (const bad of ['QR==', 'QUJ=', loose, 'a', 'ab=', 'abc', '!!!!', 'ab=c', '=abc', 'a===', 'QQ=A', `${real.slice(0, 8)}-${real.slice(9)}`,
    `${real.slice(0, 8)}_${real.slice(9)}`, `${real.slice(0, 8)} ${real.slice(9)}`, `${real.slice(0, 8)}${String.fromCharCode(0xe9)}${real.slice(9)}`]) {
    assert.equal(skr.decodeBase64(bad), null, JSON.stringify(bad));
  }
  for (const junk of [undefined, null, 42, {}, ['QQ==']]) assert.equal(skr.decodeBase64(junk), null);
  assert.deepEqual(skr.decodeBase64(''), new Uint8Array(0));
});

// ---------------------------------------------------------------- decoders and PDA
test('assertAccount fails closed on null, owner, length, discriminator, base64, and the wrong kind', () => {
  const g = fx.accounts.sampleUserStake as Acc;
  assert.equal(skr.assertAccount(info(g), 'user').ok, true);
  assert.deepEqual(skr.assertAccount(null, 'user'), { ok: false, reason: 'user: missing' });
  assert.deepEqual(skr.assertAccount(false, 'user'), { ok: false, reason: 'user: missing' });
  assert.deepEqual(skr.assertAccount(info({ ...g, owner: SYSTEM }), 'user'), { ok: false, reason: 'user: wrong owner' });
  assert.deepEqual(skr.assertAccount({ ...info(g), owner: undefined }, 'user'), { ok: false, reason: 'user: wrong owner' });
  assert.deepEqual(skr.assertAccount(info({ ...g, dataBase64: g.dataBase64.slice(0, -8) }), 'user'), { ok: false, reason: 'user: length 165' });
  assert.deepEqual(skr.assertAccount(info(g), 'config'), { ok: false, reason: 'config: length 169' }); // right owner, wrong kind
  assert.deepEqual(skr.assertAccount(info({ ...g, dataBase64: '!!not base64!!' }), 'user'), { ok: false, reason: 'user: bad base64' });
  assert.deepEqual(skr.assertAccount({ ...info(g), data: [42, 'base64'] }, 'user'), { ok: false, reason: 'user: bad base64' });
  assert.deepEqual(skr.assertAccount({ ...info(g), data: undefined }, 'user'), { ok: false, reason: 'user: length 0' });
  assert.deepEqual(skr.assertAccount(edited(g, (b) => { b[0] ^= 1; }), 'user'), { ok: false, reason: 'user: discriminator' });
  // A config-length account with the UserStake discriminator is still refused as a config.
  const cfg = fx.accounts.stakeConfig as Acc;
  assert.deepEqual(skr.assertAccount(edited(cfg, (b) => b.set(skr.DISC.user, 0)), 'config'), { ok: false, reason: 'config: discriminator' });
});

test('decoders match the fixture: StakeConfig and every UserStake', () => {
  const a = skr.assertAccount(info(fx.accounts.stakeConfig), 'config');
  assert.ok(a.ok);
  const c = skr.decodeStakeConfig(a.data);
  for (const [k, v] of Object.entries(X.stakeConfig)) if (k !== 'address') assert.equal(String((c as any)[k]), String(v), `config.${k}`);
  assert.equal(c.sharePrice, BigInt(X.testValues.sharePrice));
  const users: Array<[Acc, any]> = [[fx.accounts.sampleUserStake, X.sampleUserStake],
    ...fx.accounts.userStakes.map((acc: Acc, i: number) => [acc, X.userStakes[i]] as [Acc, any])];
  for (const [acc, x] of users) {
    const u = skr.assertAccount(info(acc), 'user');
    assert.ok(u.ok, x.label);
    const d = skr.decodeUserStake(u.data);
    for (const k of Object.keys(d)) assert.equal(String((d as any)[k]), String(x[k]), `${x.label ?? 'sample'}.${k}`);
    assert.equal(skr.stakedRawOf(d.shares, c.sharePrice), BigInt(x.stakedRaw));
  }
});

test('userStakePda re-derives every live account (bumps 252 to 255) and the missing one', () => {
  assert.deepEqual(skr.userStakePda(W), { pda: '13MeApxaDr2tXPk3eAsfVmRjNznLobMXDGMxquTiZhq', bump: 254 });
  assert.deepEqual(skr.userStakePda(MISSING), { pda: '5ZXR984KDHRG7KznwrV3k3sMcTkf2WcZrSFMSQrkrSx9', bump: 255 });
  const bumps = new Set<number>();
  for (const x of X.userStakes) {
    assert.deepEqual(skr.userStakePda(x.user), { pda: x.address, bump: x.bump }, x.label);
    assert.deepEqual(skr.userStakePda(x.user, skr.GUARDIAN_POOLS[0]), { pda: x.address, bump: x.bump });
    bumps.add(x.bump);
  }
  assert.deepEqual([...bumps].sort(), [252, 254, 255]);
  const plan = planOf(W);
  assert.deepEqual(skr.planAddresses(plan), [skr.STAKE_CONFIG, '13MeApxaDr2tXPk3eAsfVmRjNznLobMXDGMxquTiZhq']);
  for (const bad of ['', 'not-a-wallet', '0'.repeat(44), W.slice(0, 20), `${W} `, `I${W.slice(1)}`]) {
    assert.equal(skr.planStakeRead(bad), null, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- the reply
test('decodeStakeReply: every fixture wallet gives the captured stake, cooldown and weight', () => {
  for (const { user, label, x } of WALLETS) {
    const r = readOf(user);
    assert.equal(r.status, 'ok', label);
    assert.equal(r.reason, undefined, label);
    assert.equal(r.slot, fx.slot);
    assert.equal(r.sharePrice, BigInt(X.stakeConfig.sharePrice));
    assert.equal(r.cooldownSeconds, BigInt(X.stakeConfig.cooldownSeconds));
    assert.equal(r.minStakeAmount, BigInt(X.stakeConfig.minStakeAmount));
    assert.equal(r.stakedRaw, BigInt(x.stakedRaw), label);
    assert.equal(r.stakedSkr, x.stakedSkr, label);
    assert.equal(r.unstakingRaw, BigInt(x.unstakingAmount), label);
    assert.equal(r.unstakingSkr, x.unstakingSkr, label);
    assert.equal(r.withdrawableAt, x.withdrawableAt === null ? null : Number(x.withdrawableAt), label);
    assert.equal(r.weight, x.weight, label);
    assert.equal(r.checkedAt, CAPTURED_MS);
    assert.deepEqual(r.pools, [{ pool: skr.GUARDIAN_POOLS[0], pda: x.address ?? X.sampleUserStake.address, shares: BigInt(x.shares), stakedRaw: BigInt(x.stakedRaw) }]);
  }
  assert.equal(readOf(W).weight, X.testValues.sampleWeight);          // 3.66 at 45,881.16 SKR
  const none = readOf(MISSING);
  assert.deepEqual([none.status, none.stakedRaw, none.stakedSkr, none.unstakingRaw, none.withdrawableAt, none.weight],
    ['none', BigInt(0), 0, BigInt(0), null, 1]);
});

test('decodeStakeReply fails closed on a short reply, a bad config and a position that is not this wallet\'s', () => {
  const cfg = fx.accounts.stakeConfig as Acc;
  const sample = fx.accounts.sampleUserStake as Acc;
  const unknown = (r: StakeRead, reason: string, label: string) => {
    assert.deepEqual([r.status, r.reason, r.stakedSkr, r.weight, r.stakedRaw, r.withdrawableAt], ['unknown', reason, null, 1, BigInt(0), null], label);
  };
  const plan = planOf(W);
  unknown(skr.decodeStakeReply(plan, { context: { slot: 1 }, value: [info(cfg)] }, 0), 'rpc: short reply', 'short');
  unknown(skr.decodeStakeReply(plan, { context: { slot: 1 }, value: null }, 0), 'rpc: short reply', 'null value');
  unknown(skr.decodeStakeReply(plan, undefined, 0), 'rpc: short reply', 'no result');
  unknown(skr.decodeStakeReply(plan, reply(skr.planAddresses(plan), (v) => [...v, null]), 0), 'rpc: short reply', 'long');
  unknown(readOf(W, (v) => [null, v[1]]), 'config: missing', 'no config');
  unknown(readOf(W, (v) => [{ ...(v[0] as object), owner: SYSTEM }, v[1]]), 'config: wrong owner', 'config owner');
  unknown(readOf(W, (v) => [edited(cfg, (b) => { b[41] ^= 1; }), v[1]]), 'config: semantic mismatch', 'mint');
  unknown(readOf(W, (v) => [edited(cfg, (b) => { b[73] ^= 1; }), v[1]]), 'config: semantic mismatch', 'vault');
  unknown(readOf(W, (v) => [edited(cfg, (b) => b.fill(0, 137, 153)), v[1]]), 'config: semantic mismatch', 'share price 0');
  unknown(readOf(W, (v) => [edited(cfg, (b) => b.fill(0, 113, 121)), v[1]]), 'config: semantic mismatch', 'cooldown 0');
  unknown(readOf(W, (v) => [{ ...info(cfg), data: [cfg.dataBase64.slice(0, 100), 'base64'] }, v[1]]), 'config: length 75', 'config cut');
  // Someone else's real position served at this wallet's PDA.
  unknown(readOf(MISSING, (v) => [v[0], info(sample)]), 'user: semantic mismatch', 'other wallet');
  unknown(readOf(W, (v) => [v[0], edited(sample, (b) => { b[8] ^= 1; })]), 'user: semantic mismatch', 'bump');
  unknown(readOf(W, (v) => [v[0], edited(sample, (b) => { b[9] ^= 1; })]), 'user: semantic mismatch', 'config key');
  unknown(readOf(W, (v) => [v[0], edited(sample, (b) => { b[73] ^= 1; })]), 'user: semantic mismatch', 'pool key');
  unknown(readOf(W, (v) => [v[0], edited(sample, (b) => { b[0] ^= 1; })]), 'user: discriminator', 'user disc');
  unknown(readOf(W, (v) => [v[0], { ...info(sample), owner: SYSTEM }]), 'user: wrong owner', 'user owner');
  unknown(readOf(W, (v) => [v[0], { ...info(sample), data: 'abc' }]), 'user: bad base64', 'data not an array');
  unknown(readOf(W, (v) => [v[0], false]), 'user: missing', 'false entry');
  // Lamports sent to the PDA (System-owned, no data) are "no position", not an error anyone can cause.
  const gift = readOf(MISSING, (v) => [v[0], { owner: SYSTEM, lamports: 890880, data: ['', 'base64'], executable: false, rentEpoch: 0 }]);
  assert.deepEqual([gift.status, gift.stakedSkr, gift.weight], ['none', 0, 1]);
  // A System account WITH data is not that case.
  unknown(readOf(MISSING, (v) => [v[0], { owner: SYSTEM, lamports: 1, data: ['QQ==', 'base64'] }]), 'user: wrong owner', 'system with data');
  // A slot the reply does not carry is 0, and the card then prints no slot.
  const noSlot = skr.decodeStakeReply(plan, { value: reply(skr.planAddresses(plan)).value }, 0);
  assert.deepEqual([noSlot.status, noSlot.slot], ['ok', 0]);
});

// ---------------------------------------------------------------- the network call
type Call = { url: string; body: any };
function scripted(steps: Array<(body: any) => Response | Error | 'hang'>) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url, body });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)](body);
    if (step === 'hang') {
      return new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    }
    if (step instanceof Error) throw step;
    return step;
  };
  return { f, calls };
}
const okBody = (body: any) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: reply(body.params[0]) }));
const status = (s: number, text = '') => () => new Response(text, { status: s });

test('readStakeOnce: one getMultipleAccounts (base64, confirmed; the config, then the PDA) and the fixture read', async () => {
  const { f, calls } = scripted([okBody]);
  const sleeps: number[] = [];
  const r = await skr.readStakeOnce({ rpcUrl: 'https://rpc.example/x', fetch: f, now: () => CAPTURED_MS, sleep: async (ms) => { sleeps.push(ms); } }, W);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://rpc.example/x');
  assert.deepEqual(calls[0].body, {
    jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts',
    params: [[skr.STAKE_CONFIG, '13MeApxaDr2tXPk3eAsfVmRjNznLobMXDGMxquTiZhq'], { encoding: 'base64', commitment: 'confirmed' }],
  });
  assert.deepEqual([r.status, r.stakedRaw, r.weight, r.slot, r.checkedAt], ['ok', BigInt(X.sampleUserStake.stakedRaw), 3.66, fx.slot, CAPTURED_MS]);
  assert.deepEqual(sleeps, []);
});

test('readStakeOnce: one retry on 429, 5xx and a dropped connection; none on a timeout, a 4xx, an RPC error or a bad body', async () => {
  const run = async (steps: Array<(body: any) => Response | Error | 'hang'>, timeoutMs = 5_000) => {
    const { f, calls } = scripted(steps);
    const sleeps: number[] = [];
    const r = await skr.readStakeOnce({ rpcUrl: 'u', fetch: f, timeoutMs, sleep: async (ms) => { sleeps.push(ms); } }, W);
    return { r, n: calls.length, sleeps };
  };
  let o = await run([status(429), okBody]);
  assert.deepEqual([o.r.status, o.n, o.sleeps], ['ok', 2, [600]]);
  o = await run([status(503), okBody]);
  assert.deepEqual([o.r.status, o.n], ['ok', 2]);
  o = await run([() => new Error('socket hang up'), okBody]);
  assert.deepEqual([o.r.status, o.n], ['ok', 2]);
  o = await run([status(500)]);
  assert.deepEqual([o.r.status, o.r.reason, o.n], ['unknown', 'rpc 500', 2]);
  o = await run([() => new Error('offline')]);
  assert.deepEqual([o.r.status, o.r.reason, o.n], ['unknown', 'network', 2]);
  o = await run([() => 'hang', okBody], 20);
  assert.deepEqual([o.r.status, o.r.reason, o.n], ['unknown', 'timeout', 1]);
  o = await run([status(403, 'forbidden')]);
  assert.deepEqual([o.r.status, o.r.reason, o.n], ['unknown', 'rpc 403', 1]);
  // Provider text can name the endpoint or its key: none of it reaches the read.
  o = await run([() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'https://secret.example/?api-key=abc down' } }))]);
  assert.deepEqual([o.r.status, o.r.reason, o.n], ['unknown', 'rpc: error', 1]);
  assert.ok(!JSON.stringify(o.r, (_k, v) => (typeof v === 'bigint' ? String(v) : v)).includes('secret'));
  o = await run([() => new Response('<html>proxy</html>')]);
  assert.deepEqual([o.r.status, o.r.reason, o.n], ['unknown', 'rpc: bad reply', 1]);
  o = await run([() => new Response('null')]);
  assert.deepEqual([o.r.status, o.r.reason], ['unknown', 'rpc: bad reply']);
  o = await run([() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 5 }, value: [] } }))]);
  assert.deepEqual([o.r.status, o.r.reason, o.n], ['unknown', 'rpc: short reply', 1]);
  // A key that is not a wallet costs no call at all.
  const { f, calls } = scripted([okBody]);
  const bad = await skr.readStakeOnce({ rpcUrl: 'u', fetch: f }, 'not-a-wallet');
  assert.deepEqual([bad.status, bad.reason, calls.length], ['unknown', 'wallet: bad key', 0]);
});

// ---------------------------------------------------------------- weight, amounts, sentences
test('weight curve: the worker\'s table, the demo wallet (3.06x), the cap and junk', () => {
  const table: Array<[unknown, number]> = [[null, 1], [undefined, 1], [0, 1], [-5, 1], [Number.NaN, 1], [Number.POSITIVE_INFINITY, 1],
    [100, 1.3], [1000, 2.04], [10000, 3], [11355.88, 3.06], [1355.88, 2.16], [45465.44, 3.66], [99900, 4], [1e9, 4]];
  for (const [s, w] of table) assert.equal(skr.weightFor(s as number), w, String(s));
  for (const x of WALLETS.map((w) => w.x)) assert.equal(skr.weightFor(x.stakedSkr), x.weight);
  // The demo wallet (HuiUjM...) on 2026-09-30: 10,000,000,000 shares at share price 1147028992.
  const raw = skr.stakedRawOf(BigInt(10_000_000_000), BigInt(1147028992));
  assert.equal(raw, BigInt(11_470_289_920));
  assert.equal(skr.toSkr(raw), 11470.28992);
  assert.equal(skr.weightFor(skr.toSkr(raw)), 3.06);
  assert.equal(skr.formatSkrRaw(raw), '11,470.29');
});

test('formatSkrRaw and cooldownLine', () => {
  const f = (n: number) => skr.formatSkrRaw(BigInt(n));
  assert.deepEqual([f(0), f(1), f(4_999), f(5_000), f(999_999_999), f(54_796_707), f(45_881_159_680), f(1_234_567_890_123_456)],
    ['0.00', '0.00', '0.00', '0.01', '1,000.00', '54.80', '45,881.16', '1,234,567,890.12']);
  assert.equal(f(-5), '0.00');
  const at = 1_790_854_197; // 2026-10-01T11:29:57Z
  assert.equal(skr.cooldownLine(at, at * 1000), 'Withdrawable now');
  assert.equal(skr.cooldownLine(at, at * 1000 + 1), 'Withdrawable now');
  assert.equal(skr.cooldownLine(at, at * 1000 - 1), 'Withdrawable in 1m');
  assert.equal(skr.cooldownLine(at, at * 1000 - 60_000), 'Withdrawable in 1m');
  assert.equal(skr.cooldownLine(at, at * 1000 - 60_001), 'Withdrawable in 2m');
  assert.equal(skr.cooldownLine(at, at * 1000 - 3_600_000), 'Withdrawable in 1h');
  assert.equal(skr.cooldownLine(at, at * 1000 - 172_800_000), 'Withdrawable in 48h');
  assert.equal(skr.cooldownLine(at, CAPTURED_MS), 'Withdrawable in 31h 15m');
});

test('card view: each state says only what its read shows', () => {
  const opts = { noGenesis: false, nowMs: CAPTURED_MS };
  const sample = skr.stakeCardView(readOf(W), opts);
  assert.deepEqual(sample, {
    ok: true, amount: '45,881.16 SKR', weight: 'Vouch weight 3.66x', weightNote: null, unstaking: null, cooldown: null,
    source: "Read on chain from Solana Mobile's staking program, slot 451,853,888.", error: null,
  });
  const byLabel = (l: string) => WALLETS.find((w) => w.label.startsWith(l))!;
  const partial = WALLETS.filter((w) => w.label.startsWith('unstaking in cooldown')).map((w) => skr.stakeCardView(readOf(w.user), opts));
  assert.deepEqual(partial.map((v) => [v.amount, v.weight, v.unstaking, v.cooldown]), [
    ['18,712.38 SKR', 'Vouch weight 3.27x', 'Unstaking 1,000.00 SKR', 'Withdrawable in 31h 15m'],
    ['54.80 SKR', 'Vouch weight 1.19x', 'Unstaking 400.00 SKR', 'Withdrawable in 45h 58m'],
  ]);
  const over = skr.stakeCardView(readOf(byLabel('cooldown over').user), opts);
  assert.deepEqual([over.amount, over.weight, over.unstaking, over.cooldown], ['33,858.95 SKR', 'Vouch weight 3.53x', 'Unstaking 1.00 SKR', 'Withdrawable now']);
  const none = skr.stakeCardView(readOf(MISSING), opts);
  assert.deepEqual([none.ok, none.amount, none.weight, none.unstaking, none.cooldown], [true, '0.00 SKR', 'Vouch weight 1.00x', null, null]);
  // No Genesis Token in the wallet: the stake still shows, the weight does not.
  const noSgt = skr.stakeCardView(readOf(W), { ...opts, noGenesis: true });
  assert.deepEqual([noSgt.amount, noSgt.weight, noSgt.weightNote], ['45,881.16 SKR', null, skr.STAKE_NO_GENESIS]);
  // A failed read: one sentence, no amount, no weight, not even 1.00x.
  for (const bad of [skr.unknownRead('network', 0), readOf(W, (v) => [v[0], false])]) {
    assert.deepEqual(skr.stakeCardView(bad, opts), {
      ok: false, amount: null, weight: null, weightNote: null, unstaking: null, cooldown: null, source: null, error: skr.STAKE_READ_ERROR,
    });
  }
  const plan = planOf(W);
  const noSlot = skr.stakeCardView(skr.decodeStakeReply(plan, { value: reply(skr.planAddresses(plan)).value }, 0), opts);
  assert.equal(noSlot.source, "Read on chain from Solana Mobile's staking program.");
});

test('card copy: plain sentences, no em dash, no forward promises', () => {
  const opts = { noGenesis: false, nowMs: CAPTURED_MS };
  const views = [...WALLETS.map((w) => readOf(w.user)), readOf(MISSING), skr.unknownRead('x', 0)]
    .flatMap((r) => [skr.stakeCardView(r, opts), skr.stakeCardView(r, { ...opts, noGenesis: true })]);
  const strings = [skr.STAKE_EXPLAINER, skr.STAKE_SHARED_NOTE, skr.STAKE_NO_GENESIS, skr.STAKE_READ_ERROR,
    ...views.flatMap((v) => Object.values(v).filter((x): x is string => typeof x === 'string'))];
  for (const s of strings) {
    assert.ok(!s.includes(EM_DASH), s);
    assert.ok(!/\b(never|guarantee|guaranteed|always|soon|will)\b/i.test(s), s);
    assert.ok(s.trim() === s && s.length > 0, JSON.stringify(s));
  }
});
