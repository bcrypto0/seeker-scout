import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  unpackMint,
  getMetadataPointerState,
  getTokenGroupMemberState,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';

export const APP_IDENTITY = {
  name: 'Seeker Scout',
  uri: 'https://seekerscout.app', // TODO: your domain
};

/**
 * Seeker Genesis Token (SGT) constants — from official docs:
 * https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token
 * SGT is a Token-2022 NFT (not a Metaplex collection). Verification checks
 * mint authority + metadata pointer + group membership.
 */
const SGT_MINT_AUTHORITY = 'GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4';
const SGT_METADATA_ADDRESS = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
const SGT_GROUP_MINT_ADDRESS = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// getTokenAccountsByOwnerV2 is a Helius-specific RPC method.
const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY'; // TODO

/** Connect via Mobile Wallet Adapter (Seed Vault on Seeker). */
export async function connectWallet(): Promise<string> {
  return await transact(async (wallet) => {
    const auth = await wallet.authorize({
      chain: 'solana:mainnet',
      identity: APP_IDENTITY,
    });
    const raw = Buffer.from(auth.accounts[0].address, 'base64');
    return new PublicKey(raw).toBase58();
  });
}

/**
 * Verify the wallet holds a Seeker Genesis Token.
 * Gates reviews to real Seeker owners. For anti-sybil claims, also record
 * the SGT MINT address (transferable between own accounts, mint stays same).
 */
export async function findGenesisToken(
  owner: string,
): Promise<string | null> {
  // 1. All Token-2022 accounts of the owner (paginated)
  const mints: PublicKey[] = [];
  let paginationKey: string | null = null;
  do {
    const res: any = await rpc('getTokenAccountsByOwnerV2', [
      owner,
      { programId: TOKEN_2022_PROGRAM },
      { encoding: 'jsonParsed', limit: 1000, ...(paginationKey ? { paginationKey } : {}) },
    ]);
    for (const acc of res?.value?.accounts ?? []) {
      const mint = acc?.account?.data?.parsed?.info?.mint;
      if (mint) mints.push(new PublicKey(mint));
    }
    paginationKey = res?.paginationKey ?? null;
  } while (paginationKey);
  if (mints.length === 0) return null;

  // 2. Inspect each mint's extensions for SGT fingerprint
  const connection = new Connection(RPC_URL);
  for (let i = 0; i < mints.length; i += 100) {
    const infos = await connection.getMultipleAccountsInfo(
      mints.slice(i, i + 100),
    );
    for (let j = 0; j < infos.length; j++) {
      const info = infos[j];
      if (!info) continue;
      try {
        const mint = unpackMint(mints[i + j], info, TOKEN_2022_PROGRAM_ID);
        const authOk =
          mint.mintAuthority?.toBase58() === SGT_MINT_AUTHORITY;
        const meta = getMetadataPointerState(mint);
        const metaOk =
          meta?.authority?.toBase58() === SGT_MINT_AUTHORITY &&
          meta?.metadataAddress?.toBase58() === SGT_METADATA_ADDRESS;
        const group = getTokenGroupMemberState(mint);
        const groupOk =
          group?.group?.toBase58() === SGT_GROUP_MINT_ADDRESS;
        if (authOk && metaOk && groupOk) return mint.address.toBase58();
      } catch {
        // not an SGT-shaped mint; skip
      }
    }
  }
  return null;
}

export async function hasGenesisToken(owner: string): Promise<boolean> {
  return (await findGenesisToken(owner)) !== null;
}

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'scout', method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}
