/**
 * Seeker Scout discovery watchdog — self-healing backstop for the two
 * pipelines that silently died on 2026-07-19/20 (LAN blip killed both;
 * nothing noticed for ~1.5 days):
 *
 *  1. Mint-watcher: if no node process is running watcher/watch.mjs,
 *     relaunch it via the Startup VBS (detached + hidden, same path a
 *     logon uses — one revival mechanism, not two).
 *  2. Catalog: if the last end-to-end "catalog refresh OK" in
 *     catalog-refresh.log is older than STALE_HOURS, re-run the refresh
 *     (scripts/refresh-catalog.mjs — it has its own sanity gates).
 *
 * Anything it had to fix (or failed to fix) is logged to watchdog.log and
 * surfaced as a Windows toast, so a persistent outage is loud, not silent.
 * Healthy runs log one OK line and stay quiet.
 *
 * Scheduled: Windows task SeekerScoutWatchdog, every 30 min (registered by
 * scripts/register-watchdog.ps1). Manual run: node scripts/watchdog.mjs
 */
import { execFileSync, execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCAL = join(process.env.LOCALAPPDATA ?? '', 'SeekerScout');
const LOG = join(LOCAL, 'watchdog.log');
const REFRESH_LOG = join(LOCAL, 'catalog-refresh.log');
const VBS = join(
  process.env.APPDATA ?? '',
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
  'SeekerScoutWatcher.vbs',
);
const STALE_HOURS = 30; // daily refresh at 10:00 → >30h means a run failed

mkdirSync(LOCAL, { recursive: true });
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
};

/** Best-effort Windows toast (burnt-toast-free: WinRT via PowerShell). */
function toast(text) {
  const ps = `
    try {
      [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
      $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
      $t = $xml.GetElementsByTagName('text'); $t.Item(0).AppendChild($xml.CreateTextNode('Seeker Scout watchdog')) | Out-Null; $t.Item(1).AppendChild($xml.CreateTextNode('${text.replace(/'/g, "''")}')) | Out-Null
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('SeekerScout').Show([Windows.UI.Notifications.ToastNotification]::new($xml))
    } catch {}
  `;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000 });
  } catch { /* toast is best-effort; the log line is the durable record */ }
}

// ---- 1. mint-watcher process check -----------------------------------------
function watcherRunning() {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        "(Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -match 'watch\\.mjs' } | Measure-Object).Count"],
      { timeout: 30000 },
    ).toString().trim();
    return Number(out) > 0;
  } catch (e) {
    log(`WARN: process check failed (${e.message}) — assuming watcher up to avoid double-launch`);
    return true;
  }
}

let fixed = [];
let failures = [];

if (!watcherRunning()) {
  log('watcher DOWN — relaunching via Startup VBS');
  if (existsSync(VBS)) {
    try {
      // wscript detaches; run-watcher.bat's own loop takes over from here.
      execFile('wscript.exe', [VBS], { detached: true }).unref?.();
      await new Promise((r) => setTimeout(r, 12000));
      if (watcherRunning()) fixed.push('mint-watcher relaunched');
      else failures.push('mint-watcher relaunch did NOT come up (check watcher.log)');
    } catch (e) {
      failures.push(`mint-watcher relaunch errored: ${e.message}`);
    }
  } else {
    failures.push(`Startup VBS missing at ${VBS}`);
  }
}

// ---- 2. catalog freshness check --------------------------------------------
function lastRefreshOkAt() {
  if (!existsSync(REFRESH_LOG)) return null;
  // Log lines look like: [2026-07-20T16:52:10.765Z] === catalog refresh OK ===
  const matches = readFileSync(REFRESH_LOG, 'utf8')
    .split('\n')
    .filter((l) => l.includes('catalog refresh OK'));
  const last = matches.at(-1)?.match(/\[([^\]]+)\]/)?.[1];
  const ts = last ? Date.parse(last) : NaN;
  return Number.isFinite(ts) ? ts : null;
}

const okAt = lastRefreshOkAt();
const ageH = okAt === null ? Infinity : (Date.now() - okAt) / 3.6e6;
if (ageH > STALE_HOURS) {
  log(`catalog STALE (last OK ${okAt ? new Date(okAt).toISOString() : 'never'}; ${ageH === Infinity ? '∞' : ageH.toFixed(1)}h) — re-running refresh`);
  // The "catalog refresh OK" marker only exists where the runner REDIRECTS
  // the refresh output (the daily task's .bat does; plain node runs don't).
  // Capture + append here so the marker this freshness check reads always
  // lands in catalog-refresh.log — else every 30-min run would re-deploy.
  let out = '';
  try {
    out = execFileSync('node', [join(ROOT, 'scripts', 'refresh-catalog.mjs')], {
      cwd: ROOT,
      timeout: 10 * 60 * 1000,
      encoding: 'utf8',
    });
    appendFileSync(REFRESH_LOG, out);
    fixed.push('catalog refresh re-run OK');
  } catch (e) {
    appendFileSync(REFRESH_LOG, (e.stdout ?? '') + (e.stderr ?? ''));
    failures.push('catalog refresh re-run FAILED (see catalog-refresh.log)');
  }
}

// ---- summary ---------------------------------------------------------------
if (failures.length) {
  const msg = `NEEDS ATTENTION: ${failures.join('; ')}`;
  log(msg);
  toast(msg);
  process.exitCode = 1;
} else if (fixed.length) {
  const msg = `self-healed: ${fixed.join('; ')}`;
  log(msg);
  toast(msg);
} else {
  log(`OK — watcher up, catalog fresh (last OK ${(ageH).toFixed(1)}h ago)`);
}
