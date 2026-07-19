/**
 * Store-listing screenshot framer (recreates the v0.1.0 scratchpad recipe,
 * permanently). Takes raw 1200x2670 device captures and produces framed
 * marketing shots: dark gradient bg + headline + accent subline + rounded,
 * green-bordered device image.
 *
 * Usage:  node frame.mjs <inputDir> <outputDir>
 *   expects <inputDir>/{discover,games,detail,rewards,lounge}.png
 */
import sharp from 'sharp';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const W = 1200;
const H = 2670;
const SHOT_W = 900; // device shot scaled width
const SHOT_H = Math.round((SHOT_W / 1200) * 2670); // 2003
const SHOT_X = (W - SHOT_W) / 2;
const SHOT_Y = 470;
const RADIUS = 44;

const SHOTS = [
  { src: 'discover', out: '01-discover', headline: 'Every dApp, ranked live', sub: 'Scout Pick, top climbers, freshness — at a glance' },
  { src: 'detail', out: '02-detail', headline: 'Every app, in depth', sub: '7-day rank trend, on-chain verified, one-tap install' },
  { src: 'rewards', out: '03-rewards', headline: 'Perks that are actually live', sub: 'Verified Seeker rewards + SKR Season tracking' },
  { src: 'lounge', out: '04-lounge', headline: 'Claim your founding number', sub: "The Owners' Lounge — verified Seeker owners only" },
  { src: 'chat', out: '05-chat', headline: 'A room with no bots', sub: 'Genesis-verified members only — say hello' },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&apos;');

const bgSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="12%" r="85%">
      <stop offset="0%" stop-color="#0F2B1E"/>
      <stop offset="45%" stop-color="#0B1310"/>
      <stop offset="100%" stop-color="#07090B"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
</svg>`;

const textSvg = (headline, sub) => `<svg width="${W}" height="420" xmlns="http://www.w3.org/2000/svg">
  <text x="${W / 2}" y="215" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="64" font-weight="800" fill="#F5F5F7">${esc(headline)}</text>
  <text x="${W / 2}" y="295" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="30" font-weight="600" fill="#14F195">${esc(sub)}</text>
</svg>`;

const maskSvg = `<svg width="${SHOT_W}" height="${SHOT_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${SHOT_W}" height="${SHOT_H}" rx="${RADIUS}" fill="#fff"/>
</svg>`;

const borderSvg = `<svg width="${SHOT_W}" height="${SHOT_H}" xmlns="http://www.w3.org/2000/svg">
  <rect x="1.5" y="1.5" width="${SHOT_W - 3}" height="${SHOT_H - 3}" rx="${RADIUS}" fill="none" stroke="#14F195" stroke-width="3"/>
</svg>`;

async function frameOne(inDir, outDir, shot) {
  const srcPath = join(inDir, `${shot.src}.png`);
  if (!existsSync(srcPath)) {
    console.warn(`SKIP ${shot.out}: missing ${srcPath}`);
    return;
  }
  const device = await sharp(srcPath)
    .resize(SHOT_W, SHOT_H)
    .composite([
      { input: Buffer.from(maskSvg), blend: 'dest-in' },
      { input: Buffer.from(borderSvg), blend: 'over' },
    ])
    .png()
    .toBuffer();

  await sharp(Buffer.from(bgSvg))
    .composite([
      { input: Buffer.from(textSvg(shot.headline, shot.sub)), top: 0, left: 0 },
      { input: device, top: SHOT_Y, left: SHOT_X },
    ])
    .png()
    .toFile(join(outDir, `${shot.out}.png`));
  console.log(`framed ${shot.out}.png`);
}

const [inDir, outDir] = process.argv.slice(2);
if (!inDir || !outDir) {
  console.error('usage: node frame.mjs <inputDir> <outputDir>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
for (const s of SHOTS) await frameOne(inDir, outDir, s);
console.log('done');
