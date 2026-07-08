import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  unpackMint,
  getMetadataPointerState,
  getTokenGroupMemberState,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';

/** Identity shown to the wallet in the authorization prompt. */
export const APP_IDENTITY = {
  name: 'Seeker Scout',
  uri: 'https://seekerscout.app', // TODO: your real domain
};

/**
 * Public mainnet RPC — works with no API key. Swap in a premium endpoint
 * (Helius / Triton / QuickNode) for higher rate limits and reliability.
 */
export const RPC_URL = 'https://api.mainnet-beta.solana.com';

/**
 * Seeker Genesis Token (SGT) constants — SGT is a Token-2022 NFT (not a
 * Metaplex collection). Verification checks mint authority + metadata pointer
 * + group membership. See docs.solanamobile.com.
 */
const SGT_MINT_AUTHORITY = 'GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4';
const SGT_METADATA_ADDRESS = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
const SGT_GROUP_MINT_ADDRESS = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';

export type WalletConnection = { address: string; authToken: string };

/**
 * Connect via Mobile Wallet Adapter (Seed Vault on Seeker).
 * Opens the wallet's authorization prompt; the user approves in-wallet.
 */
export async function connectWallet(): Promise<WalletConnection> {
  return await transact(async (wallet) => {
    const auth = await wallet.authorize({
      chain: 'solana:mainnet',
      identity: APP_IDENTITY,
    });
    const account = auth.accounts[0];
    const address = new PublicKey(
      Buffer.from(account.address, 'base64'),
    ).toBase58();
    return { address, authToken: auth.auth_token };
  });
}

export type VerifyResult = 'verified' | 'not-found' | 'error';

/**
 * Verify the wallet holds a Seeker Genesis Token.
 * Returns 'verified' | 'not-found' (checked, none held) | 'error' (couldn't reach RPC).
 */
export async function verifyGenesisToken(owner: string): Promise<VerifyResult> {
  try {
    const connection = new Connection(RPC_URL, 'confirmed');
    const ownerPk = new PublicKey(owner);

    // 1. All Token-2022 accounts of the owner (standard RPC method — works on
    //    any endpoint, unlike the Helius-specific getTokenAccountsByOwnerV2).
    const resp = await connection.getParsedTokenAccountsByOwner(ownerPk, {
      programId: TOKEN_2022_PROGRAM_ID,
    });
    const mints = resp.value
      .map((a) => a.account.data?.parsed?.info?.mint as string | undefined)
      .filter((m): m is string => !!m)
      .map((m) => new PublicKey(m));
    if (mints.length === 0) return 'not-found';

    // 2. Inspect each mint's Token-2022 extensions for the SGT fingerprint.
    for (let i = 0; i < mints.length; i += 100) {
      const infos = await connection.getMultipleAccountsInfo(
        mints.slice(i, i + 100),
      );
      for (let j = 0; j < infos.length; j++) {
        const info = infos[j];
        if (!info) continue;
        try {
          const mint = unpackMint(mints[i + j], info, TOKEN_2022_PROGRAM_ID);
          const authOk = mint.mintAuthority?.toBase58() === SGT_MINT_AUTHORITY;
          const meta = getMetadataPointerState(mint);
          const metaOk =
            meta?.authority?.toBase58() === SGT_MINT_AUTHORITY &&
            meta?.metadataAddress?.toBase58() === SGT_METADATA_ADDRESS;
          const group = getTokenGroupMemberState(mint);
          const groupOk = group?.group?.toBase58() === SGT_GROUP_MINT_ADDRESS;
          if (authOk && metaOk && groupOk) return 'verified';
        } catch {
          // not an SGT-shaped mint; skip
        }
      }
    }
    return 'not-found';
  } catch (e) {
    console.warn('genesis token check failed', e);
    return 'error';
  }
}
