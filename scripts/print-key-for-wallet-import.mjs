/**
 * Prints your publisher key in base58 — the format Phantom/Solflare expect
 * when you "Import Private Key". Run it, paste into the wallet, then CLEAR
 * your terminal (cls). Never share this string with anyone.
 *
 *   node scripts/print-key-for-wallet-import.mjs
 */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const file = join(homedir(), 'seekerscout-publisher.json');
const kp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(file, 'utf8'))),
);

console.log('\nPublic address :', kp.publicKey.toBase58());
console.log('\nPRIVATE KEY (base58) — paste into Phantom/Solflare import, then run `cls`:\n');
console.log(bs58.encode(kp.secretKey), '\n');
