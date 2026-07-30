import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  unpackMint,
  getMetadataPointerState,
  getTokenGroupMemberState,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';

/** Identity shown to the wallet in the authorization prompt. */
export const APP_IDENTITY = {
  name: 'Seeker Scout',
  uri: 'https://seekerscout.com',
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

/** Circle USDC on Solana mainnet — the only mint we ever charge in. */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

/** SPL Memo v2 — tags the payment so a transfer can be traced to a purchase. */
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const ALPHA_MEMO = 'seekerscout:alpha:v1';

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

export type GenesisCheck = { status: VerifyResult; mint?: string };

/**
 * Verify the wallet holds a Seeker Genesis Token.
 * Returns 'verified' | 'not-found' (checked, none held) | 'error' (couldn't reach RPC).
 */
export async function verifyGenesisToken(owner: string): Promise<VerifyResult> {
  return (await findGenesisToken(owner)).status;
}

/**
 * Like verifyGenesisToken, but also returns WHICH mint is the SGT — the
 * Owners' Lounge claims are keyed on the Genesis Token mint (one per Seeker).
 */
export async function findGenesisToken(owner: string): Promise<GenesisCheck> {
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
    if (mints.length === 0) return { status: 'not-found' };

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
          if (authOk && metaOk && groupOk) {
            return { status: 'verified', mint: mints[i + j].toBase58() };
          }
        } catch {
          // not an SGT-shaped mint; skip
        }
      }
    }
    return { status: 'not-found' };
  } catch (e) {
    console.warn('genesis token check failed', e);
    return { status: 'error' };
  }
}

/**
 * Sign an arbitrary UTF-8 message with the connected wallet via MWA
 * (Seed Vault prompt on the Seeker). Returns raw signed bytes — depending on
 * the wallet these are either the 64-byte signature alone or the signature
 * concatenated with the message; callers should handle both.
 */
export async function signMessageBytes(
  address: string,
  authToken: string,
  message: string,
): Promise<Uint8Array> {
  return await transact(async (wallet) => {
    try {
      await wallet.reauthorize({
        auth_token: authToken,
        identity: APP_IDENTITY,
      });
    } catch {
      // Stale auth token (wallet restarted, session expired) — fall back to
      // a fresh authorize; the user sees one extra approval, not a failure.
      await wallet.authorize({
        chain: 'solana:mainnet',
        identity: APP_IDENTITY,
      });
    }
    const payload = new TextEncoder().encode(message);
    const signed = await wallet.signMessages({
      addresses: [new PublicKey(address).toBuffer().toString('base64')],
      payloads: [payload],
    });
    return signed[0];
  });
}

/**
 * Pay for Alpha: a plain USDC transfer from the connected wallet to the
 * treasury, plus a memo for traceability. Returns the transaction signature,
 * which the worker re-verifies on chain before granting entitlement.
 *
 * We are moving the USER's own funds at the USER's request to OUR treasury —
 * no custody, no routing, no third party. Everything that can be checked
 * BEFORE the wallet prompt is checked first (treasury validity, the payer's
 * USDC account, the balance, the destination account) so a doomed transfer is
 * never signed and no network fee is burned on a guaranteed failure.
 */
export async function payAlpha(
  address: string,
  authToken: string,
  treasury: string,
  amountUi: number,
): Promise<string> {
  if (!(amountUi > 0)) throw new Error('Invalid payment amount.');

  let treasuryPk: PublicKey;
  try {
    treasuryPk = new PublicKey(treasury);
  } catch {
    throw new Error(
      'Alpha payments are not switched on yet — no treasury address is configured.',
    );
  }

  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = new PublicKey(address);
  const mint = new PublicKey(USDC_MINT);
  // Treasury may legitimately be a PDA/multisig — allow an off-curve owner.
  const fromAta = await getAssociatedTokenAddress(mint, payer);
  const toAta = await getAssociatedTokenAddress(mint, treasuryPk, true);

  const amount = BigInt(Math.round(amountUi * 10 ** USDC_DECIMALS));

  const [fromInfo, toInfo] = await connection.getMultipleAccountsInfo([
    fromAta,
    toAta,
  ]);
  if (!fromInfo) {
    throw new Error(
      `No USDC in this wallet — add at least ${amountUi} USDC on Solana and try again.`,
    );
  }
  if (!toInfo) {
    // The treasury has never held USDC, so its token account doesn't exist.
    // Creating it for them would silently charge the user rent, and sending
    // anyway is a guaranteed on-chain failure — stop cleanly instead.
    throw new Error(
      "The Alpha treasury isn't ready to receive USDC yet — nothing was charged. Try again later.",
    );
  }

  // Balance check is best-effort: a flaky RPC read must not block a payment
  // the wallet would happily complete, so the shortfall is recorded and
  // thrown OUTSIDE the try rather than being swallowed by its own catch.
  let shortfall: string | null = null;
  try {
    const balance = await connection.getTokenAccountBalance(fromAta);
    if (BigInt(balance.value.amount) < amount) {
      shortfall = balance.value.uiAmountString ?? '0';
    }
  } catch (e) {
    console.warn('usdc balance check failed', e);
  }
  if (shortfall !== null) {
    throw new Error(
      `Not enough USDC — this wallet holds ${shortfall}, and Alpha costs ${amountUi}.`,
    );
  }

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('confirmed');

  const tx = new Transaction({
    feePayer: payer,
    blockhash,
    lastValidBlockHeight,
  }).add(
    createTransferCheckedInstruction(
      fromAta,
      mint,
      toAta,
      payer,
      amount,
      USDC_DECIMALS,
    ),
    new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM_ID),
      keys: [],
      data: Buffer.from(ALPHA_MEMO, 'utf8'),
    }),
  );

  const signature = await transact(async (wallet) => {
    try {
      await wallet.reauthorize({
        auth_token: authToken,
        identity: APP_IDENTITY,
      });
    } catch {
      // Stale auth token (wallet restarted, session expired) — fall back to
      // a fresh authorize; the user sees one extra approval, not a failure.
      await wallet.authorize({
        chain: 'solana:mainnet',
        identity: APP_IDENTITY,
      });
    }
    const signatures = await wallet.signAndSendTransactions({
      transactions: [tx],
    });
    return signatures[0];
  });

  if (!signature) throw new Error('The wallet returned no transaction signature.');
  return signature;
}
