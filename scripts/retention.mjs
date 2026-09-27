// Where do installs drop off? Reads opens_age (v0.10.1+ pings) from the
// production D1 and prints one line per day. Read-only.
//
//   node scripts/retention.mjs            # last 14 days
//   node scripts/retention.mjs 30
//   node scripts/retention.mjs 14 --local   # the local wrangler D1, for testing
//
// How to read it:
//   new   = first launch on the day of install ("first" + bucket 0). Compare
//           with the portal's installs for the same days: the gap is people
//           who installed and never opened the app.
//   d1    = installs opening the day after install ("return" + bucket 1).
//           d1 today / new yesterday ~ day-1 return rate.
//   d2-3, d4-7, d8-14, d15-30, d31+ = active installs of that age that day.
//   upg   = "first" rows older than day 0: v0.9/v0.10 users on their first
//           launch after updating (one-off, not new installs).
// Every install counts at most once a day, and the counts carry no id, so
// this tracks ages of active installs, never a person.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DAYS = Number(process.argv[2]) || 14;
const WHERE = process.argv.includes('--local') ? '--local' : '--remote';
const WORKER_DIR = fileURLToPath(new URL('../lounge-worker/', import.meta.url));
const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
const sql = `SELECT day, kind, bucket, count FROM opens_age WHERE day >= '${since}' ORDER BY day`;

let rows;
try {
  const out = execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'd1', 'execute', 'seeker-lounge', WHERE, '--json', '--command', JSON.stringify(sql)],
    { cwd: WORKER_DIR, encoding: 'utf8', shell: process.platform === 'win32' },
  );
  rows = JSON.parse(out.slice(out.indexOf('[')))[0].results;
} catch (e) {
  console.error(`D1 query failed: ${String(e.message).split('\n')[0]}`);
  process.exit(1);
}

const COLS = ['new', 'd1', 'd2-3', 'd4-7', 'd8-14', 'd15-30', 'd31+', 'upg'];
const col = (kind, bucket) => {
  if (kind === 'first') return bucket === '0' ? 'new' : 'upg';
  // 'return' + '0' can't come from the app (the day-0 send is the 'first'
  // one, and it sends once a day), so it's skipped rather than guessed at.
  if (bucket === '0') return null;
  if (bucket === '1') return 'd1';
  if (bucket === '2' || bucket === '3') return 'd2-3';
  return `d${bucket}`;
};
const byDay = new Map();
for (const r of rows) {
  const d = byDay.get(r.day) ?? Object.fromEntries(COLS.map((c) => [c, 0]));
  const c = col(r.kind, r.bucket);
  if (c in d) d[c] += r.count;
  byDay.set(r.day, d);
}
if (!byDay.size) {
  console.log(`No rows since ${since}. The counts start once v0.10.1 is live on phones.`);
  process.exit(0);
}
console.log(['day       ', ...COLS.map((c) => c.padStart(6))].join(' '));
for (const [day, d] of [...byDay].sort()) {
  console.log([day, ...COLS.map((c) => String(d[c]).padStart(6))].join(' '));
}
