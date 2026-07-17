/**
 * Automated catalog refresh: indexer → sanity gates → CF Pages deploy → live verify.
 *
 * Run by the Windows scheduled task `SeekerScoutCatalogRefresh` (daily) via
 * scripts/refresh-catalog.bat, or manually: node scripts/refresh-catalog.mjs
 *
 * Deploys ONLY if the fresh catalog passes sanity gates (>= MIN_APPS entries
 * and Seeker Scout itself present), so a broken source feed can never wipe
 * the live catalog. Wrangler auth: OAuth session in ~/.wrangler (no API token).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOG = join(ROOT, 'indexer', 'catalog.json');
const LIVE_URL = 'https://seeker-scout-catalog.pages.dev/catalog.json';
const PAGES_PROJECT = 'seeker-scout-catalog';
const MIN_APPS = 1000;
const SELF_ID = 'com.bilal.seekerscout';
const NODE = process.execPath;
const NPX = join(dirname(process.execPath), 'npx.cmd');

const DRY_RUN = process.argv.includes('--dry-run'); // everything except deploy + live verify

const stamp = () => new Date().toISOString();
const log = (msg) => console.log(`[${stamp()}] ${msg}`);

try {
  log('=== catalog refresh start ===');

  // 1. Rebuild catalog.json from the live feed (throws on non-zero exit).
  // Dry runs must not advance the first-seen ratchet state.
  execFileSync(NODE, [join(ROOT, 'indexer', 'fetch-catalog.mjs')], {
    cwd: ROOT, stdio: 'inherit', timeout: 120_000,
    env: { ...process.env, ...(DRY_RUN ? { FIRSTSEEN_READONLY: '1' } : {}) },
  });

  // 2. Sanity gates — refuse to deploy a suspicious catalog.
  const apps = JSON.parse(readFileSync(CATALOG, 'utf8'));
  if (!Array.isArray(apps) || apps.length < MIN_APPS) {
    throw new Error(`sanity gate: only ${apps?.length ?? 0} apps (< ${MIN_APPS}) — NOT deploying`);
  }
  if (!apps.some((a) => a.id === SELF_ID)) {
    throw new Error(`sanity gate: ${SELF_ID} missing from catalog — NOT deploying`);
  }
  log(`sanity OK: ${apps.length} apps, self-listing present`);

  // 3. Stage to a clean dir (wrangler deploys the whole directory).
  const stage = join(tmpdir(), 'seeker-scout-catalog-deploy');
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, 'catalog.json'), readFileSync(CATALOG));

  // 3b. Remote-config side files (banners, rewards) ride along when valid;
  // a broken side file must never block the catalog deploy.
  for (const name of ['banners.json', 'rewards.json']) {
    const src = join(ROOT, 'indexer', name);
    if (!existsSync(src)) continue;
    try {
      const data = JSON.parse(readFileSync(src, 'utf8'));
      if (!Array.isArray(data)) throw new Error('not an array');
      writeFileSync(join(stage, name), JSON.stringify(data, null, 1));
      log(`staged ${name}: ${data.length} entries`);
    } catch (e) {
      log(`WARN: ${name} invalid (${e.message}) — not staged`);
    }
  }

  if (DRY_RUN) {
    log(`DRY RUN: staged ${apps.length} apps at ${stage}; skipping deploy + live verify`);
    log('=== catalog refresh OK (dry run) ===');
    process.exit(0);
  }

  // 4. Deploy to CF Pages via the wrangler OAuth session.
  // NPX lives under "Program Files" — must be quoted because shell:true
  // builds a command line (unquoted, the scheduled task dies at 'C:\Program').
  execFileSync(`"${NPX}"`, ['wrangler', 'pages', 'deploy', stage,
    '--project-name', PAGES_PROJECT, '--branch', 'main', '--commit-dirty=true'], {
    cwd: ROOT, stdio: 'inherit', timeout: 300_000, shell: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });

  // 5. Verify the production URL serves the new count (node TLS — no CRYPT_E_REVOCATION issue).
  const res = await fetch(LIVE_URL, { signal: AbortSignal.timeout(20_000) });
  const live = await res.json();
  if (live.length === apps.length) {
    log(`LIVE VERIFIED: ${live.length} apps at ${LIVE_URL}`);
  } else {
    log(`WARN: live count ${live.length} != local ${apps.length} (CDN cache lag? re-check later)`);
  }
  log('=== catalog refresh OK ===');
} catch (e) {
  log(`FAILED: ${e.message}`);
  process.exit(1);
}
