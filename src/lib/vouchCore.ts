/**
 * Scout Vouch, the half of the client that needs no phone: the signed
 * message, the note rules, the tags, the response parsers, the sentence the
 * screens show for every answer the worker can give, and the network calls
 * with their transport injected (fetch, signer, clock, storage).
 *
 * No React Native import and no relative import, on purpose: `npm run
 * test:app` loads this file with Node's type stripping, and the local
 * end-to-end harness drives these same calls against `wrangler dev` with an
 * ed25519 key standing in for Seed Vault. src/lib/vouch.ts wires them to MWA
 * and AsyncStorage.
 *
 * The contract is the LIVE worker (lounge-worker/src/vouch.js and
 * vouch-lib.js), not the spec text. vouchMessage and normalizeNote must give
 * the worker's bytes exactly: vouchCore.parity.test.ts imports the worker's
 * own file and compares both over fixtures and a seeded corpus.
 */

export type VouchVerdict = 'works' | 'broken';
export type VouchTag = 'wallet_ok' | 'crashes' | 'needs_update';
export type VouchTier = 'founding' | 'early' | 'member';

/** Bit order matters: it is the order the signed `tags:` line uses (vouch-lib.js TAG_NAMES). */
export const VOUCH_TAGS: readonly { id: VouchTag; bit: number; label: string }[] = [
  { id: 'wallet_ok', bit: 1, label: 'Wallet connect worked' },
  { id: 'crashes', bit: 2, label: 'Crashes' },
  { id: 'needs_update', bit: 4, label: 'Needs an update' },
];
export const VERDICTS: readonly VouchVerdict[] = ['works', 'broken'];
export const MAX_NOTE = 140;
/** The `note:` and `tags:` lines render "nothing" as this; the worker refuses a note equal to it. */
export const NOTE_PLACEHOLDER = '-';
/** The worker's per-wallet slot (vouch.js RATE_MS): one accepted vouch per wallet per 10 s. */
export const RATE_MS = 10_000;
/**
 * The longest wait before the one retry of a 503 'busy'. The worker counts its
 * chain-check budget per UTC minute (index.js takeRpcBudget), so a retry only
 * helps once the server's minute has turned: postVouch waits until then, read
 * from the answer's Date header, and never longer than this.
 */
export const BUSY_MAX_WAIT_MS = 61_000;
/**
 * How long one signed payload is re-posted instead of asking the wallet again.
 * The worker accepts a signature for 10 minutes; 8 leaves 2 for a phone clock
 * that runs behind the server's.
 */
export const REUSE_SIGNED_MS = 8 * 60_000;
/** Distinct apps one Genesis Token can vouch for (vouch.js MAX_PACKAGES_PER_MINT). */
export const PACKAGE_LIMIT = 50;
/** The Works on Seeker chip rule (vouch-lib.js). Evaluated by the worker only; these feed the hint copy. */
export const CHIP_MIN_VOICES = 3;
export const CHIP_MIN_WORKS_PCT = 80;

/** AsyncStorage keys (seekerscout.<thing>.v1 convention). */
export const MY_VOUCH_KEY = 'seekerscout.vouch.mine.v1';
export const FLAGS_KEY = 'seekerscout.flags.v1';

export interface VouchInput {
  package: string;
  verdict: VouchVerdict;
  tags: VouchTag[];
  note: string;
}

/**
 * One app's public aggregate (vouch-lib.js finishAggregate), head counts
 * only. The weighted totals (weight_works, weight_broken, weight_works_week)
 * are neither read nor kept, whether the worker sends them or not: on an app
 * with one voice the total is that voice's weight, which gives away roughly
 * what its owner stakes.
 */
export interface AppVouchSummary {
  package: string;
  voices: number;
  worksVoices: number;
  brokenVoices: number;
  worksPct: number;
  walletOkVoices: number;
  worksOnSeeker: boolean;
  lastVouchAt: string | null;
}

/**
 * A public recent note. No wallet, no mint, no stake, no weight: a weight next
 * to a Lounge number would tell every reader roughly what that owner stakes,
 * so the app neither reads nor keeps one here, whether the worker sends it or not.
 */
export interface VouchNote {
  id: number;
  verdict: VouchVerdict;
  tags: VouchTag[];
  note: string;
  number: number | null;
  tier: VouchTier | null;
  updatedAt: string;
}

export interface AppVouches {
  app: AppVouchSummary;
  recent: VouchNote[];
}

/**
 * What GET /vouch/mine returns per package: the verdict and the two
 * moderation flags, NOTHING else (no id, no updated_at, no tags, no note, no
 * weight). The owner's own tags, note and weight come from the last POST
 * /vouch answer this device cached (cachedResult below).
 */
export interface MyVouch {
  package: string;
  verdict: VouchVerdict;
  noteHidden: boolean;
  excluded: boolean;
}

/** skr.js reports where the stake came from; 'stored' is a replay answered from D1. */
export type WeightSource = 'chain' | 'cache' | 'stub' | 'error' | 'stored' | 'unknown';

/** The signed POST /vouch answer: the only place the app learns its own weight and stake. */
export interface VouchResult {
  replayed: boolean;
  number: number | null;
  tier: VouchTier | null;
  vouch: {
    id: number;
    package: string;
    verdict: VouchVerdict;
    tags: VouchTag[];
    note: string;
    weight: number;
    signedTs: string;
    updatedAt: string;
    noteHidden: boolean;
    excluded: boolean;
  };
  weight: number;
  stakedSkr: number | null;
  weightSource: WeightSource;
  mintsInWallet: number;
  app: AppVouchSummary;
}

export interface TopRow extends AppVouchSummary {
  voicesWeek: number;
}

/** GET /vouch/top: the current UTC week (Monday 00:00Z to the next Monday), top 10, never a zero row. */
export interface TopWeek {
  week: string;
  start: string;
  end: string;
  apps: TopRow[];
}

/** GET /flags. The worker reads its settings rows with settingOn: only '1' is on. */
export interface RemoteFlags {
  vouch: boolean;
  vote: boolean;
  stake: boolean;
  skrRead: boolean;
  withdraw: boolean;
}

/**
 * What the worker itself answers on an empty settings table (a missing row
 * reads as on, except withdraw). Used only on a first run with no network:
 * after one good fetch the last-good copy wins. Failing open is safe because
 * the worker gates its own writes: a hidden-by-mistake button would be the
 * only harm of failing closed, a shown-by-mistake one gets an honest 503.
 */
export const FLAG_DEFAULTS: RemoteFlags = Object.freeze({
  vouch: true,
  vote: true,
  stake: true,
  skrRead: true,
  withdraw: false,
});

/* -------------------------------- helpers -------------------------------- */

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const flag = (v: unknown): boolean => v === true || v === 1;
const isVerdict = (v: unknown): v is VouchVerdict => v === 'works' || v === 'broken';
const TIERS: readonly VouchTier[] = ['founding', 'early', 'member'];
const tierOf = (v: unknown): VouchTier | null =>
  TIERS.includes(v as VouchTier) ? (v as VouchTier) : null;

/** Hand-rolled base58, copied per module by convention (lounge.ts, alpha.ts, chat.ts). */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

/* ------------------ message: byte-identical to vouch-lib.js ------------------ */

/** Tag ids in bit order, de-duplicated, unknown ids dropped: exactly what the `tags:` line lists. */
export function orderedTags(tags: readonly unknown[] | undefined | null): VouchTag[] {
  if (!Array.isArray(tags)) return [];
  const set = new Set<unknown>(tags);
  return VOUCH_TAGS.filter((t) => set.has(t.id)).map((t) => t.id);
}

/** vouch-lib.js canonicalTags: bit order, or "-" when empty. */
export function canonicalTags(tags: readonly unknown[] | undefined | null): string {
  const names = orderedTags(tags);
  return names.length ? names.join(',') : NOTE_PLACEHOLDER;
}

/**
 * Byte for byte the worker's sanitizeNote: the same four link passes as
 * chat.js, then whitespace collapsed and a 140 cut. Plain regexes, no
 * normalize(), no Unicode folding, so Hermes on the phone and V8 on the
 * worker agree. Do not "improve" this without changing the worker first:
 * the worker accepts a note only when note === sanitizeNote(note).
 */
export function normalizeNote(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const R = '[link removed]';
  let t = raw.replace(/\s+/g, ' ').trim();
  t = t.replace(/\b(?:https?|ftp|tg|solana):\/\/\S+/gi, R);
  t = t.replace(/\bwww\.\S+/gi, R);
  t = t.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?:[:/]\S*)?/g, R);
  t = t.replace(/\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?/gi, R);
  return t.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE).trim();
}

/**
 * The note the app actually signs. normalizeNote until it stops changing,
 * because the worker refuses (400) a note that is not a fixed point, and one
 * pass is not always one: 'x.io1.2.3.4' becomes '[link removed]1.2.3.4' and
 * the next pass strips the IP (the corner the worker's comment names), and
 * the parity corpus finds the same thing whenever a link is glued to a digit
 * run or to text already reading '[link removed]'. Only notes that held a
 * link get there; two or three passes settle them, eight is headroom. Then a
 * lone '-' becomes no note: the worker reserves it (400 'note reserved') and
 * someone typing a dash means "nothing to add".
 */
export function prepareNote(raw: unknown): string {
  let t = normalizeNote(raw);
  for (let i = 0; i < 8; i++) {
    t = dropTrailingHighSurrogate(t);
    const next = normalizeNote(t);
    if (next === t) break;
    t = next;
  }
  return t === NOTE_PLACEHOLDER ? '' : t;
}

/**
 * The 140 cut counts UTF-16 units, so when link removal pushes an emoji
 * across it, the cut keeps only the emoji's first half. The worker accepts
 * that lone half and D1 stores it as replacement characters, so the public
 * note would differ from the signed one. Dropping it before the fixed-point
 * check keeps the note well formed and still a fixed point of sanitizeNote.
 */
function dropTrailingHighSurrogate(t: string): string {
  const last = t.length ? t.charCodeAt(t.length - 1) : 0;
  return last >= 0xd800 && last <= 0xdbff ? t.slice(0, -1) : t;
}

/** Explicit bidi embeddings, overrides and isolates (U+202A-U+202E, U+2066-U+2069): vouch-lib.js BIDI_CONTROL. */
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/;

/**
 * Client pre-check, deliberately a SUBSET of the worker's hasHiddenLink: it
 * refuses only the bidi controls, which the worker refuses unconditionally,
 * so it can never be stricter than the worker. The rest of hasHiddenLink
 * (look-alike dots, slashes and colons, zero-width and combining marks,
 * fullwidth letters) needs normalize('NFKD') and Unicode property classes,
 * which Hermes is not relied on for; those notes reach the worker and come
 * back as the same 400, which has its own sentence. Catching bidi here saves
 * a Seed Vault prompt for the one case that is never an honest review.
 */
export function noteBlockedLocally(note: string): boolean {
  return BIDI_CONTROL.test(note);
}

/**
 * What the sheet shows under the note field when signing would change what
 * was typed beyond whitespace (a link removed, or a lone dash dropped), or
 * null when the note goes out as typed.
 */
export function notePreview(raw: string): string | null {
  const typed = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  const sent = prepareNote(raw);
  if (sent === typed) return null;
  // prepareNote only empties what whitespace already emptied, or a lone dash.
  if (sent === '') return 'A lone dash means no note, so none is sent.';
  return `Links are removed. Your note will read: “${sent}”`;
}

/** The exact bytes the app asks Seed Vault to sign (vouch-lib.js vouchMessage). */
export function vouchMessage(f: {
  wallet: string;
  mint: string;
  ts: string;
  package: string;
  verdict: string;
  tags?: readonly unknown[] | null;
  note?: string | null;
}): string {
  return [
    'Seeker Scout \u2014 Vouch',
    'purpose: vouch-v1',
    `wallet: ${f.wallet}`,
    `mint: ${f.mint}`,
    `package: ${f.package}`,
    `verdict: ${f.verdict}`,
    `tags: ${canonicalTags(f.tags)}`,
    `note: ${f.note ? f.note : NOTE_PLACEHOLDER}`,
    `ts: ${f.ts}`,
  ].join('\n');
}

/* --------------------------------- parsers --------------------------------- */

function parseTags(v: unknown): VouchTag[] {
  return orderedTags(Array.isArray(v) ? v : []);
}

export function parseSummary(v: unknown): AppVouchSummary | null {
  const r = obj(v);
  const pkg = r ? str(r.package) : null;
  if (!r || !pkg) return null;
  const voices = num(r.voices) ?? 0;
  const worksVoices = num(r.works_voices) ?? 0;
  return {
    package: pkg,
    voices,
    worksVoices,
    brokenVoices: num(r.broken_voices) ?? Math.max(0, voices - worksVoices),
    worksPct: num(r.works_pct) ?? 0,
    walletOkVoices: num(r.wallet_ok_voices) ?? 0,
    worksOnSeeker: r.works_on_seeker === true,
    lastVouchAt: str(r.last_vouch_at),
  };
}

/** GET /vouch/app/<package> body, bad rows dropped (alpha.ts rows() posture). */
export function parseAppVouches(v: unknown): AppVouches | null {
  const body = obj(v);
  const app = body ? parseSummary(body.app) : null;
  if (!body || !app) return null;
  const recent: VouchNote[] = [];
  for (const raw of Array.isArray(body.recent) ? body.recent : []) {
    const r = obj(raw);
    if (!r) continue;
    const id = num(r.id);
    if (id === null || !isVerdict(r.verdict)) continue;
    const number = num(r.number);
    recent.push({
      id,
      verdict: r.verdict,
      tags: parseTags(r.tags),
      note: typeof r.note === 'string' ? r.note : '',
      number: number !== null && Number.isInteger(number) ? number : null,
      tier: tierOf(r.tier),
      updatedAt: str(r.updated_at) ?? '',
    });
  }
  return { app, recent };
}

/** GET /vouch/mine body: {vouches: [{package, verdict, note_hidden, excluded}]}. Null when the shape is wrong. */
export function parseMine(v: unknown): MyVouch[] | null {
  const body = obj(v);
  if (!body || !Array.isArray(body.vouches)) return null;
  const out: MyVouch[] = [];
  for (const raw of body.vouches) {
    const r = obj(raw);
    const pkg = r ? str(r.package) : null;
    if (!r || !pkg || !isVerdict(r.verdict)) continue;
    out.push({ package: pkg, verdict: r.verdict, noteHidden: flag(r.note_hidden), excluded: flag(r.excluded) });
  }
  return out;
}

export function parseTop(v: unknown): TopWeek | null {
  const body = obj(v);
  if (!body || !Array.isArray(body.apps)) return null;
  const apps: TopRow[] = [];
  for (const raw of body.apps) {
    const s = parseSummary(raw);
    const r = obj(raw);
    if (!s || !r) continue;
    const voicesWeek = num(r.voices_week) ?? 0;
    if (voicesWeek <= 0) continue; // the worker's HAVING already guarantees this
    apps.push({ ...s, voicesWeek });
  }
  return { week: str(body.week) ?? '', start: str(body.start) ?? '', end: str(body.end) ?? '', apps };
}

const WEIGHT_SOURCES: readonly WeightSource[] = ['chain', 'cache', 'stub', 'error', 'stored'];

/** The POST /vouch 200 body. Null when it is not the shape vouch.js vouchResponse() builds. */
export function parseResult(v: unknown): VouchResult | null {
  const r = obj(v);
  const vo = r ? obj(r.vouch) : null;
  const app = r ? parseSummary(r.app) : null;
  if (!r || !vo || !app) return null;
  const id = num(vo.id);
  const pkg = str(vo.package);
  if (id === null || !pkg || !isVerdict(vo.verdict)) return null;
  const number = num(r.number);
  const src = r.weight_source;
  const mints = num(r.mints_in_wallet);
  return {
    replayed: r.replayed === true,
    number: number !== null && Number.isInteger(number) ? number : null,
    tier: tierOf(r.tier),
    vouch: {
      id,
      package: pkg,
      verdict: vo.verdict,
      tags: parseTags(vo.tags),
      note: typeof vo.note === 'string' ? vo.note : '',
      weight: num(vo.weight) ?? 1,
      signedTs: str(vo.signed_ts) ?? '',
      updatedAt: str(vo.updated_at) ?? '',
      noteHidden: flag(vo.note_hidden),
      excluded: flag(vo.excluded),
    },
    weight: num(r.weight) ?? num(vo.weight) ?? 1,
    stakedSkr: num(r.staked_skr),
    weightSource: WEIGHT_SOURCES.includes(src as WeightSource) ? (src as WeightSource) : 'unknown',
    mintsInWallet: mints !== null && mints >= 1 ? Math.floor(mints) : 1,
    app,
  };
}

/**
 * GET /flags body. Null unless it is an object carrying a boolean `vouch`
 * (the one flag this app acts on), so a proxy page or a truncated body falls
 * back to the last good copy instead of being read as "everything on". A
 * field that is missing or not a boolean takes the worker's own default.
 */
export function parseFlags(v: unknown): RemoteFlags | null {
  const r = obj(v);
  if (!r || typeof r.vouch !== 'boolean') return null;
  const pick = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d);
  return {
    vouch: r.vouch,
    vote: pick(r.vote, FLAG_DEFAULTS.vote),
    stake: pick(r.stake, FLAG_DEFAULTS.stake),
    skrRead: pick(r.skr_read, FLAG_DEFAULTS.skrRead),
    withdraw: pick(r.withdraw, FLAG_DEFAULTS.withdraw),
  };
}

/* ------------------------------ error sentences ------------------------------ */

/**
 * A failed vouch: the worker's status and short error string (`code`), and a
 * sentence for the screen as the message. A plain Error with fields rather
 * than a subclass, so instanceof can't be broken by transpilation (alpha.ts).
 */
export type VouchError = Error & { status: number; code: string };

const SEND_FAILED = "Something went wrong sending your vouch. Try again.";
const SERVICE_BUSY = 'The vouch service is busy. Try again in a minute.';
const SIG_UNREADABLE = "Your wallet returned a signature the server couldn't read. Try again.";
export const PAUSED_SENTENCE = 'Vouching is paused. Try again later.';
export const OFFLINE_SENTENCE = "Couldn't reach the vouch service. Check your connection and try again.";
export const LIMIT_SENTENCE =
  `This Seeker has vouched for ${PACKAGE_LIMIT} apps, the most one Genesis Token can. You can still change the vouches you already made.`;

/**
 * One sentence per error string the live worker can return on POST /vouch
 * (vouch.js parseVouchBody, handleVouchPost and readJson; index.js
 * verifyGenesisSig), plus the client's own 'network' and 'unexpected
 * response'. A Map, not an object literal, so a code like 'constructor'
 * can never resolve to something on Object.prototype.
 */
const SENTENCES = new Map<string, string>([
  ['vouching is paused', PAUSED_SENTENCE],
  ['busy, try again in a minute', 'Lots of Seeker owners are checking in right now. Try again in a minute.'],
  ['slow down', 'One vouch every 10 seconds. Give it a moment, then try again.'],
  ['superseded by a newer vouch from this Seeker',
    'A newer vouch from this Seeker is already recorded. Reopen this app page and try again.'],
  ['vouch limit reached', LIMIT_SENTENCE],
  ['not a Seeker Genesis Token', "That token isn't a Seeker Genesis Token, so this wallet can't vouch."],
  ['wallet does not hold this token',
    'This wallet no longer holds that Genesis Token. Reconnect with the wallet that holds it.'],
  ['account blocked', 'Vouching is switched off for this wallet.'],
  ['note contains a link or is not normalised',
    'Notes cannot carry links, including look-alike dots, slashes or hidden characters. Edit the note and try again.'],
  ['note reserved', 'A note cannot be just a dash. Write a few words or leave it empty.'],
  ['note must be one line of at most 140 characters', 'Keep the note to one line of 140 characters or fewer.'],
  ['verdict must be works or broken', 'Pick Works or Broken first.'],
  ['tags must be an array', SEND_FAILED],
  ['bad package id', "This app's id can't take vouches."],
  ['bad wallet or mint', "Your wallet or Genesis Token address couldn't be read. Reconnect your wallet and try again."],
  ['bad signature length', SIG_UNREADABLE],
  ['bad key or signature length', SIG_UNREADABLE],
  ['bad encoding', SIG_UNREADABLE],
  ['signature verification failed',
    "Your wallet's signature didn't match this vouch. Try again, and reconnect your wallet if it keeps happening."],
  ['bad ts', "Your phone gave a time the server can't read. Check the date and time settings, then try again."],
  ['stale message',
    "Your phone's clock is a few minutes off, or the signature took too long. Check the date and time, then try again."],
  ['missing fields', SEND_FAILED],
  ['bad json', SEND_FAILED],
  ['bad body', SEND_FAILED],
  ['body too large', 'That vouch is too big to send. Shorten the note and try again.'],
  ['storage error', SERVICE_BUSY],
  ['vouch service error', SERVICE_BUSY],
  ['not found', "This version of Seeker Scout can't reach vouching. Update the app and try again."],
  ['network', OFFLINE_SENTENCE],
  ['unexpected response', "Your vouch was sent, but the answer couldn't be read. Reopen this app page to check it."],
]);

/** The sentence for a worker answer. Unknown strings fall back on the status, never on raw server text. */
export function vouchErrorMessage(status: number, code: string): string {
  const exact = SENTENCES.get(code);
  if (exact) return exact;
  if (code.startsWith('chain check unavailable')) {
    return "Couldn't reach Solana to check your Genesis Token. Try again in a minute.";
  }
  if (status === 0) return OFFLINE_SENTENCE;
  if (status === 401) return SENTENCES.get('signature verification failed')!;
  if (status === 403) return "This wallet can't vouch right now.";
  if (status === 409) return SENTENCES.get('superseded by a newer vouch from this Seeker')!;
  if (status === 429) return SENTENCES.get('slow down')!;
  if (status >= 500) return SERVICE_BUSY;
  if (status === 400) return SEND_FAILED;
  return `Your vouch didn't go through (error ${status}). Try again.`;
}

export function vouchError(status: number, code: string): VouchError {
  return Object.assign(new Error(vouchErrorMessage(status, code)), { status, code });
}

/** Status of an error this module threw, or undefined (a wallet cancel, say). */
export function vouchErrorStatus(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null | undefined)?.status;
  return typeof s === 'number' ? s : undefined;
}

export function vouchErrorCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null | undefined)?.code;
  return typeof c === 'string' ? c : undefined;
}

/**
 * The sentence for an error that did not come from the worker (no status):
 * a wallet prompt that was cancelled, declined or timed out, or no wallet app
 * at all. MWA's own messages ('Local association cancelled by user', 'Timed
 * out waiting for response') are developer text, so they are never shown.
 */
export function walletErrorSentence(e: unknown, during: 'connect' | 'sign'): string {
  if ((e as { code?: unknown } | null | undefined)?.code === 'ERROR_WALLET_NOT_FOUND') {
    return 'No Solana wallet app was found on this phone.';
  }
  return during === 'sign' ? 'Signing cancelled. Nothing was sent.' : 'Connection cancelled.';
}

/* --------------------------------- UI copy --------------------------------- */

export const verdictLabel = (v: VouchVerdict): string => (v === 'works' ? 'Works' : 'Broken');

export function tagLabels(tags: readonly VouchTag[]): string {
  return orderedTags(tags)
    .map((id) => VOUCH_TAGS.find((t) => t.id === id)!.label)
    .join(' · ');
}

/** "Founder #12" for a Lounge seat, "Seeker owner" for a Genesis holder who never claimed one. */
export function tierLabel(number: number | null, tier: VouchTier | null): string {
  if (number === null) return 'Seeker owner';
  if (tier === 'founding') return `Founder #${number}`;
  if (tier === 'early') return `Pioneer #${number}`;
  return `Member #${number}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** 11355.88 -> "11,355.88". No Intl, so Hermes and Node print the same. */
export function formatSkr(n: number): string {
  const [whole, frac] = n.toFixed(2).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

/**
 * The owner's weight, honestly. The worker reads the wallet's staked SKR
 * (not SKR in an unstake cooldown) on every signed vouch and answers where
 * it came from: 'chain' or 'cache' with a number, 'error' with null (1.00x),
 * 'stub' only from a worker without the reader, 'stored' on a replay from
 * D1, which can be a row written before the reader (null, 1.00x) and stays
 * so until that owner vouches again. The app never prints a multiplier it
 * did not get from the worker: `r` is the last signed answer, or null before
 * any, and then the line says how weight works instead of a number.
 *
 * The sheet also prints this line above "Sign with Seed Vault", from the
 * last answer, so every line is about a vouch already made, never a forecast
 * of the one being signed (that one reads the stake afresh). A failed read
 * puts only the vouch it served at 1.00x (worker vouch.js step 9), hence
 * "your last vouch" rather than "your voice".
 *
 * Release order: the null line, like WEIGHT_CAPTION, says the stake is read
 * when an owner signs, which only the worker with the D6 reader (skr.js
 * readStakeWeight, migrations/002_skr_cache.sql) does. That worker goes live
 * before any build carrying this copy, and a rollback to the stub reader
 * reverts this copy with it.
 */
export function weightLine(r: VouchResult | null): string {
  if (!r) return 'Staked SKR can raise your voice up to 4x. Your stake is read when you sign.';
  const unread = 'Your voice counts 1.00x because your SKR stake was not read.';
  if (r.weightSource === 'stub') return unread;
  // A replay ('stored') of a row no stake was read for: a pre-reader row or a failed read. The next vouch reads it.
  if (r.weightSource === 'stored' && r.stakedSkr === null && Math.abs(r.weight - 1) < 0.005) {
    return `${unread} Vouching again reads it.`;
  }
  const w = `${r.weight.toFixed(2)}x`;
  if (r.weightSource === 'error') {
    return "Your last vouch counts 1.00x: your SKR stake couldn't be read. Vouching again retries the read.";
  }
  if ((r.weightSource === 'chain' || r.weightSource === 'cache') && r.stakedSkr !== null) {
    if (r.stakedSkr <= 0) return `Your voice counts ${w} with no SKR staked.`;
    const shared = r.mintsInWallet > 1 ? `, shared by ${r.mintsInWallet} Seekers` : '';
    return `Your voice counts ${w} on ${formatSkr(r.stakedSkr)} SKR staked${shared}.`;
  }
  return `Your voice counts ${w}.`;
}

/**
 * The caption under an app's numbers. One sentence for every app: a caption
 * that switched between "every voice counts 1.00x" and "weighted" would tell
 * readers, on an app with one voice, whether that owner (named by a Lounge
 * number in the notes) stakes SKR. Every number on the card is a head count;
 * the weight only orders apps (the Lounge list breaks ties on it). "Read when
 * an owner vouches" needs the D6 worker live: see weightLine's release order.
 */
export const WEIGHT_CAPTION =
  'Staked SKR, read when an owner vouches, can weigh a voice up to 4x in rankings. The numbers above count each Genesis Token once.';

/**
 * Why the Works on Seeker chip is missing, or null when it shows. The worker
 * decides the chip; this only explains it. With every weight at least 1.00x
 * its "3.0 works weight" rule is implied by 3 owners at 80%, so the copy
 * names the two rules a reader can act on.
 */
export function chipHint(s: AppVouchSummary): string | null {
  if (s.worksOnSeeker) return null;
  if (s.voices < CHIP_MIN_VOICES) {
    return `Needs ${plural(CHIP_MIN_VOICES - s.voices, 'more owner')} to earn the Works on Seeker chip.`;
  }
  return `The Works on Seeker chip needs ${CHIP_MIN_WORKS_PCT}% of owners saying it works.`;
}

export function walletChip(n: number): { text: string; a11y: string } {
  return {
    text: `Wallet connect worked · ${n}`,
    a11y: `Wallet connect worked for ${plural(n, 'owner')}`,
  };
}

/**
 * One Lounge row. voices_week is this week's count, but works_pct comes from
 * every vouch the app ever got (vouch.js topThisWeek reads AGG_COLUMNS with no
 * week filter), so the percentage names its base whenever the two differ.
 */
export function topRowMeta(r: TopRow): string {
  const week = `${plural(r.voicesWeek, 'owner')} this week`;
  return r.voices === r.voicesWeek
    ? `${week} · ${r.worksPct}% say it works`
    : `${week} · ${r.worksPct}% of ${plural(r.voices, 'owner')} say it works`;
}

/**
 * The Lounge rows: only apps the catalog knows, ranked after that filter.
 * The worker takes any package-shaped id ('www.some-site.com' is one), so a
 * raw id must never be printed as if it were an app.
 */
export function knownTopRows<E>(
  apps: readonly TopRow[],
  lookup: (pkg: string) => E | undefined,
  limit: number,
): { row: TopRow; entry: E }[] {
  const out: { row: TopRow; entry: E }[] = [];
  for (const row of apps) {
    if (out.length >= limit) break;
    const entry = lookup(row.package);
    if (entry !== undefined) out.push({ row, entry });
  }
  return out;
}

/**
 * True when this Genesis Token already vouched for PACKAGE_LIMIT other apps.
 * GET /vouch/mine lists every row of the mint, excluded ones too, which is
 * exactly what the worker's cap counts, so a new app past it would cost a
 * Seed Vault prompt for a certain 403. False when the read failed (null):
 * the worker's 403 sentence is the fallback then.
 */
export function atVouchLimit(mine: readonly MyVouch[] | null, pkg: string): boolean {
  return !!mine && mine.length >= PACKAGE_LIMIT && !mine.some((m) => m.package === pkg);
}

/**
 * What the sheet says once the worker answered 200. The answer can still say
 * the voice does not count (an operator-excluded row answers 200 with
 * excluded:true) or that the note stays hidden, so never "Recorded." alone
 * then.
 */
export function vouchDoneCopy(r: VouchResult): { title: string; counts: boolean; lines: string[] } {
  if (r.vouch.excluded) {
    return {
      title: 'Saved.',
      counts: false,
      lines: ['Your vouch is saved but does not count: it was removed by the operator.'],
    };
  }
  const lines = [weightLine(r)];
  if (r.vouch.noteHidden) lines.push('Your note stays hidden by moderation; your verdict counts.');
  return { title: 'Recorded.', counts: true, lines };
}

/** The sheet's button while postVouch waits for the server's minute to turn after a 503 'busy'. */
export function busyRetryLabel(resumeAt: number | null, now = Date.now()): string {
  const s = resumeAt === null ? 0 : Math.max(0, Math.ceil((resumeAt - now) / 1000));
  return s > 0 ? `Busy right now. Retrying in ${s} s…` : 'Retrying…';
}

/** The owner's own vouch on one app, merged from GET /vouch/mine and the cached signed answer. */
export type OwnState =
  | { kind: 'none' }
  | { kind: 'excluded' }
  | {
      kind: 'mine';
      verdict: VouchVerdict;
      noteHidden: boolean;
      /** From this device's last signed answer; null after a reinstall or on another phone. */
      detail: { tags: VouchTag[]; note: string; result: VouchResult } | null;
    };

/**
 * `mine` null means the read failed: then the cached answer stands in. A
 * successful read is the authority: no row means no vouch, whatever the
 * cache says, and a cached answer whose verdict disagrees with the row is
 * older than the row and is not shown.
 */
export function ownState(mine: MyVouch[] | null, cached: VouchResult | null, pkg: string): OwnState {
  const fromCache = cached && cached.vouch.package === pkg ? cached : null;
  if (mine === null) {
    if (!fromCache) return { kind: 'none' };
    if (fromCache.vouch.excluded) return { kind: 'excluded' };
    return {
      kind: 'mine',
      verdict: fromCache.vouch.verdict,
      noteHidden: fromCache.vouch.noteHidden,
      detail: { tags: fromCache.vouch.tags, note: fromCache.vouch.note, result: fromCache },
    };
  }
  const row = mine.find((m) => m.package === pkg);
  if (!row) return { kind: 'none' };
  if (row.excluded) return { kind: 'excluded' };
  const match = fromCache && fromCache.vouch.verdict === row.verdict ? fromCache : null;
  return {
    kind: 'mine',
    verdict: row.verdict,
    noteHidden: row.noteHidden,
    detail: match ? { tags: match.vouch.tags, note: match.vouch.note, result: match } : null,
  };
}

/* --------------------------------- network --------------------------------- */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Everything the calls below touch outside themselves, injectable for Node tests. */
export interface VouchDeps {
  base: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** Key-value storage with AsyncStorage's shape. */
export interface KV {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function timed(deps: VouchDeps, path: string, init: RequestInit, ms: number): Promise<Response> {
  const f: FetchLike = deps.fetch ?? ((u, i) => fetch(u, i));
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await f(`${deps.base}${path}`, { ...init, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

async function getJson(deps: VouchDeps, path: string, ms: number): Promise<unknown | null> {
  try {
    const res = await timed(deps, path, {}, ms);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * GET /vouch/app/<package>; null on any failure (lounge.ts read posture).
 * `bust` adds a throwaway query the worker ignores: the route answers with
 * max-age 60 and Android's HTTP stack keeps a cache, so the read right after
 * a vouch must not be served the copy from before it.
 */
export async function fetchAppVouches(deps: VouchDeps, pkg: string, bust?: string): Promise<AppVouches | null> {
  const q = bust ? `?r=${encodeURIComponent(bust)}` : '';
  return parseAppVouches(await getJson(deps, `/vouch/app/${encodeURIComponent(pkg)}${q}`, 10_000));
}

/** GET /vouch/mine (no-store on the worker). Null on failure, which is not the same as "no vouches". */
export async function fetchMyVouches(deps: VouchDeps, mint: string): Promise<MyVouch[] | null> {
  return parseMine(await getJson(deps, `/vouch/mine?mint=${encodeURIComponent(mint)}`, 10_000));
}

/** GET /vouch/top (max-age 120 on the worker); `bust` as for fetchAppVouches. */
export async function fetchTopVouched(deps: VouchDeps, bust?: string): Promise<TopWeek | null> {
  const q = bust ? `?r=${encodeURIComponent(bust)}` : '';
  return parseTop(await getJson(deps, `/vouch/top${q}`, 10_000));
}

/**
 * GET /flags (max-age 60 on the worker). `bust`, as for fetchAppVouches, is
 * for the read right before a wallet prompt: a pause must not hide behind a
 * copy the phone's HTTP cache kept from before it.
 */
export async function fetchFlags(deps: VouchDeps, bust?: string): Promise<RemoteFlags | null> {
  const q = bust ? `?r=${encodeURIComponent(bust)}` : '';
  return parseFlags(await getJson(deps, `/flags${q}`, 5_000));
}

/**
 * The kill switches for this launch: live from GET /flags, else the last
 * good copy this device saved, else (first run, no network) the defaults.
 * Never throws.
 */
export async function loadRemoteFlags(
  deps: VouchDeps,
  kv: KV,
  bust?: string,
): Promise<{ flags: RemoteFlags; source: 'live' | 'last-good' | 'defaults' }> {
  const live = await fetchFlags(deps, bust);
  if (live) {
    try {
      await kv.setItem(FLAGS_KEY, JSON.stringify({ flags: live, at: (deps.now ?? (() => new Date()))().toISOString() }));
    } catch {
      // Saving is a convenience; the live answer still counts.
    }
    return { flags: live, source: 'live' };
  }
  try {
    const raw = await kv.getItem(FLAGS_KEY);
    const saved = raw ? parseSavedFlags(JSON.parse(raw)) : null;
    if (saved) return { flags: saved, source: 'last-good' };
  } catch {
    // Unreadable copy: fall through to the defaults.
  }
  return { flags: { ...FLAG_DEFAULTS }, source: 'defaults' };
}

function parseSavedFlags(v: unknown): RemoteFlags | null {
  const f = obj(obj(v)?.flags);
  if (!f) return null;
  return parseFlags({ vouch: f.vouch, vote: f.vote, stake: f.stake, skr_read: f.skrRead, withdraw: f.withdraw });
}

export type SignFn = (message: string) => Promise<Uint8Array>;

/**
 * 'signing' right before the wallet prompt, 'sending' once the signature is
 * back (or straight away when a signed payload is re-posted), 'waiting' while
 * a 503 'busy' waits for the server's minute to turn (`resumeAt` is when the
 * retry goes out, in this clock's milliseconds).
 */
export type SubmitStage = 'signing' | 'sending' | 'waiting';

/** A signed payload kept after a failure that may pass on a later try (network, 5xx, busy, 429). */
export interface PendingSigned {
  /** wallet|mint|package|verdict|tags|note: only the same vouch reuses the signature. */
  key: string;
  /** The signed ts; the payload is reused while it is younger than REUSE_SIGNED_MS. */
  ts: string;
  /** base58 signatures still worth trying, in order (a 401 drops one). */
  signatures: string[];
}

/** Where the last signed payload lives between submits (module state on the phone). */
export interface PendingStore {
  get(): PendingSigned | null;
  set(p: PendingSigned | null): void;
}

export interface SubmitArgs {
  wallet: string;
  mint: string;
  input: VouchInput;
  /** Asks the wallet to sign; called at most once per submit, and not at all when `pending` holds this vouch. */
  sign: SignFn;
  onStage?: (stage: SubmitStage, info?: { resumeAt: number }) => void;
  /**
   * Keeps the signed payload across submits: after a busy, network or 5xx
   * failure, tapping the button again with the same vouch re-posts it with no
   * second wallet prompt. The worker answers a payload that already landed
   * from D1 (200 replayed), so this is always safe.
   */
  pending?: PendingStore;
}

type PostAnswer = { ok: boolean; status: number; body: unknown; date: string | null };

async function postOnce(deps: VouchDeps, payload: Record<string, unknown>): Promise<PostAnswer> {
  // 20 s: the worker may make three RPC round-trips behind the signature check.
  const res = await timed(deps, '/vouch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, 20_000);
  let body: unknown = {};
  try {
    body = await res.json();
  } catch {
    // Only a 200 we cannot read may have recorded the vouch. An error page
    // (a Cloudflare 522, an HTML 503 or 429) did not: an empty code makes the
    // status pick the sentence and the retry.
    body = res.ok ? { error: 'unexpected response' } : {};
  }
  return { ok: res.ok, status: res.status, body, date: res.headers?.get?.('date') ?? null };
}

/**
 * How long to wait after a 503 'busy' so the retry lands in the server's next
 * UTC minute (its budget key). `date` is the answer's Date header (whole
 * seconds, so one second of margin); without a readable one, the longest
 * wait, which crosses a minute from any instant.
 */
export function busyWaitMs(date: string | null): number {
  const t = date ? Date.parse(date) : NaN;
  if (!Number.isFinite(t)) return BUSY_MAX_WAIT_MS;
  const s = new Date(t).getUTCSeconds();
  return Math.min(BUSY_MAX_WAIT_MS, (60 - s + 1) * 1000);
}

/** The pending key: a signature is only ever reused for the exact same vouch. */
function pendingKey(wallet: string, mint: string, pkg: string, verdict: string, tags: readonly unknown[], note: string): string {
  return JSON.stringify([wallet, mint, pkg, verdict, canonicalTags(tags), note]);
}

/**
 * Keep the signed payload after this status? Yes when a later try can pass
 * with the same signature: no answer (0), 429, any 5xx, or a 200 we could not
 * read. A 4xx the worker decided (400, 401, 403, 409, ...) ends it.
 */
const keepsPending = (status: number) => !(status >= 400 && status < 500 && status !== 429);

const errorOf = (body: unknown): string => {
  const e = obj(body)?.error;
  return typeof e === 'string' ? e : '';
};

/**
 * Sign once, then post the SAME payload through every retry (lounge.ts
 * claimFounderNumber pattern; the worker's freshness window is 10 minutes).
 * The wallet is never asked twice for one vouch: not on a network error, not
 * on a 5xx, a 429 or a 503 'busy', and, with `pending`, not on the next tap
 * either while the signature is younger than REUSE_SIGNED_MS.
 *
 * - Signature shape: wallets return either the 64-byte signature or the
 *   signature followed by the message; anything longer than 64 bytes tries
 *   the first 64, then the last 64, and only a 401 moves to the second.
 * - 429 'slow down' (our own 10 s slot): wait RATE_MS + 500 once, retry.
 * - 503 'busy, try again in a minute' (the shared chain-check budget, counted
 *   per UTC minute): wait until the server's next minute (busyWaitMs), once,
 *   retry. A 503 with another code is the kill switch: stop at once.
 * - Network error or another 5xx (an unreadable 503 included): up to three
 *   attempts, 1.5 s then 3 s apart. A retry of a payload that already landed
 *   comes back 200 with replayed:true, straight from D1.
 * - 409 after a try whose answer was lost (or on a reused payload): that try
 *   may have been our own write, still running at the edge when the retry
 *   read the row. Re-post once after 1.5 s; the worker answers our own
 *   signature from D1 (200 replayed). Only a second 409 is final.
 * - Anything else (400, 403, 409) is final and comes back as its sentence.
 */
export async function postVouch(deps: VouchDeps, args: SubmitArgs): Promise<VouchResult> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? (() => new Date());
  const { wallet, mint, input } = args;
  if (!isVerdict(input.verdict)) throw vouchError(400, 'verdict must be works or broken');
  const note = prepareNote(input.note);
  if (noteBlockedLocally(note)) throw vouchError(400, 'note contains a link or is not normalised');
  const tags = orderedTags(input.tags);
  const key = pendingKey(wallet, mint, input.package, input.verdict, tags, note);
  const store = args.pending;

  const send = async (ts: string, signatures: string[], reused: boolean): Promise<VouchResult> => {
    const remember = (sigs: string[]) => store?.set(sigs.length ? { key, ts, signatures: sigs } : null);
    const forget = () => {
      const p = store?.get();
      if (p && p.key === key && p.ts === ts) store?.set(null);
    };
    remember(signatures);
    let lastCode = 'signature verification failed';
    for (let i = 0; i < signatures.length; i++) {
      const payload = {
        wallet, mint, ts, signature: signatures[i],
        package: input.package, verdict: input.verdict, tags, note,
      };
      let failures = 0;
      let waited429 = false;
      let waitedBusy = false;
      let reposted409 = false;
      // True once a try may have landed without us hearing so.
      let uncertain = reused;
      for (;;) {
        let res: PostAnswer;
        try {
          res = await postOnce(deps, payload);
        } catch {
          uncertain = true;
          failures += 1;
          if (failures >= 3) throw vouchError(0, 'network');
          await sleep(1500 * failures);
          continue;
        }
        if (res.ok) {
          const parsed = parseResult(res.body);
          if (!parsed) throw vouchError(res.status, 'unexpected response');
          forget();
          return parsed;
        }
        const code = errorOf(res.body);
        if (res.status >= 500) uncertain = true;
        if (res.status === 401) {
          lastCode = code || 'signature verification failed';
          remember(signatures.slice(i + 1));
          break; // the alternate slice, if there is one
        }
        if (res.status === 429 && !waited429) {
          waited429 = true;
          await sleep(RATE_MS + 500);
          continue;
        }
        if (res.status === 503 && code.startsWith('busy') && !waitedBusy) {
          waitedBusy = true;
          const wait = busyWaitMs(res.date);
          args.onStage?.('waiting', { resumeAt: now().getTime() + wait });
          await sleep(wait);
          args.onStage?.('sending');
          continue;
        }
        if (res.status === 409 && uncertain && !reposted409) {
          reposted409 = true;
          await sleep(1500);
          continue;
        }
        if (res.status >= 500 && !(res.status === 503 && code)) {
          failures += 1;
          if (failures >= 3) throw vouchError(res.status, code);
          await sleep(1500 * failures);
          continue;
        }
        if (!keepsPending(res.status)) forget();
        throw vouchError(res.status, code);
      }
    }
    throw vouchError(401, lastCode);
  };

  const prior = store?.get() ?? null;
  const age = prior ? now().getTime() - Date.parse(prior.ts) : NaN;
  if (prior && prior.key === key && prior.signatures.length > 0 && age >= 0 && age < REUSE_SIGNED_MS) {
    args.onStage?.('sending');
    try {
      return await send(prior.ts, prior.signatures, true);
    } catch (e) {
      // Only a clock further behind the server's than the margin gets here: sign afresh (one prompt).
      if (vouchErrorCode(e) !== 'stale message') throw e;
    }
  }

  const ts = now().toISOString(); // generated once per signature, reused by every retry
  const message = vouchMessage({ wallet, mint, ts, package: input.package, verdict: input.verdict, tags, note });
  args.onStage?.('signing');
  const signed = await args.sign(message);
  args.onStage?.('sending');
  if (!(signed instanceof Uint8Array) || signed.length < 64) throw vouchError(400, 'bad signature length');
  const candidates = signed.length === 64 ? [signed] : [signed.slice(0, 64), signed.slice(-64)];
  return send(ts, candidates.map((c) => base58Encode(c)), false);
}

/* ------------------------ the owner's cached answers ------------------------ */

type CacheEntry = { mint: string; savedAt: number; result: VouchResult };
const CACHE_MAX = 120;

async function readCache(kv: KV): Promise<Record<string, CacheEntry>> {
  try {
    const raw = await kv.getItem(MY_VOUCH_KEY);
    const parsed = raw ? obj(JSON.parse(raw)) : null;
    return (parsed ?? {}) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

const cacheKey = (mint: string, pkg: string) => `${mint}|${pkg}`;

function validEntry(e: unknown, mint: string, pkg?: string): VouchResult | null {
  const entry = obj(e);
  const result = entry ? obj(entry.result) : null;
  const vouch = result ? obj(result.vouch) : null;
  if (!entry || entry.mint !== mint || !result || !vouch || typeof vouch.package !== 'string') return null;
  if (pkg !== undefined && vouch.package !== pkg) return null;
  if (!isVerdict(vouch.verdict) || !obj(result.app)) return null;
  return result as unknown as VouchResult;
}

/**
 * Keep the last signed answer per (Genesis mint, package): the only copy of
 * the owner's tags, note and weight, since GET /vouch/mine serves none of
 * them. Keyed by mint so a second Seeker on the same phone never shows the
 * first one's vouch. Convenience only; failures are swallowed.
 */
export async function rememberResult(kv: KV, mint: string, result: VouchResult, now = Date.now()): Promise<void> {
  try {
    const all = await readCache(kv);
    all[cacheKey(mint, result.vouch.package)] = { mint, savedAt: now, result };
    const keys = Object.keys(all);
    if (keys.length > CACHE_MAX) {
      keys
        .sort((a, b) => (Number(all[a]?.savedAt) || 0) - (Number(all[b]?.savedAt) || 0))
        .slice(0, keys.length - CACHE_MAX)
        .forEach((k) => delete all[k]);
    }
    await kv.setItem(MY_VOUCH_KEY, JSON.stringify(all));
  } catch {
    // convenience only
  }
}

export async function cachedResult(kv: KV, mint: string, pkg: string): Promise<VouchResult | null> {
  const all = await readCache(kv);
  return validEntry(all[cacheKey(mint, pkg)], mint, pkg);
}

/** The newest cached answer for this mint on any app: the sheet's weight line (weightLine) is about it. */
export async function latestCachedResult(kv: KV, mint: string): Promise<VouchResult | null> {
  const all = await readCache(kv);
  let best: { at: number; r: VouchResult } | null = null;
  for (const e of Object.values(all)) {
    const r = validEntry(e, mint);
    const at = Number(obj(e)?.savedAt) || 0;
    if (r && (!best || at > best.at)) best = { at, r };
  }
  return best ? best.r : null;
}

/**
 * Answers whose weight the worker stamps on EVERY vouch of the wallet (vouch.js
 * step 9: a clean stake read re-stamps them all; the stub worker stamps 1.00x on
 * all). A failed read ('error') sets only the vouch it served, and a replay
 * ('stored') writes nothing, so those two speak for their own app only.
 */
const WALLET_WIDE: ReadonlySet<WeightSource> = new Set<WeightSource>(['chain', 'cache', 'stub']);

/**
 * The weight this mint's vouch on `pkg` carries, as far as this device knows:
 * from the newest of this app's own cached answer and any later answer that
 * re-stamped every vouch of the wallet. The app's own answer alone goes stale
 * as soon as the owner vouches on another app. Null without any answer.
 */
export async function cachedWeight(kv: KV, mint: string, pkg: string): Promise<number | null> {
  const all = await readCache(kv);
  let best: { at: number; w: number } | null = null;
  for (const e of Object.values(all)) {
    const r = validEntry(e, mint);
    if (!r || (r.vouch.package !== pkg && !WALLET_WIDE.has(r.weightSource))) continue;
    const at = Number(obj(e)?.savedAt) || 0;
    const w = num(r.weight);
    if (w !== null && (!best || at > best.at)) best = { at, w };
  }
  return best ? best.w : null;
}
