/**
 * Generates a fresh Solana keypair to use as your dApp Store PUBLISHER identity.
 * Writes it OUTSIDE this repo (your home folder) so it can never be committed.
 * Run once:  node scripts/gen-publisher-key.mjs
 */
import { Keypair } from '@solana/web3.js';
import { writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const out = join(homedir(), 'seekerscout-publisher.json');

if (existsSync(out)) {
  console.error(`\n⛔ A key already exists at:\n   ${out}\n   Refusing to overwrite. (Delete it first if you truly want a new one.)\n`);
  process.exit(1);
}

const kp = Keypair.generate();
writeFileSync(out, JSON.stringify(Array.from(kp.secretKey)));

console.log('\n✅ Publisher keypair created.\n');
console.log('   Keypair file (KEEP SAFE — never share or commit):');
console.log(`   ${out}\n`);
console.log('   PUBLIC ADDRESS  →  fund this with ~0.1 SOL on MAINNET:');
console.log(`   ${kp.publicKey.toBase58()}\n`);
console.log('   ⚠  Back up that .json file somewhere safe/offline.');
console.log('      Lose it and you lose control of your publisher identity.\n');
