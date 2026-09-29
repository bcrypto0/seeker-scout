// lounge-worker/src/skr.js
/**
 * Staked SKR for one wallet, read from Solana Mobile's staking program on the
 * paid RPC. Returns { stakedSkr: number|null, checkedAt: ISO,
 * source: 'chain'|'cache'|'stub'|'error' }. NEVER throws. Carries NO weight:
 * the router computes sharedStakeWeight(stakedSkr, mintsInWallet) so the
 * per-wallet division exists exactly once (vouch-lib.js). Any decode/RPC
 * failure is stakedSkr null (which weighs 1.00x). D2 ships the stub; D6
 * replaces the body with SPEC-skr's readStakeCached (getMultipleAccounts +
 * asserted decoders from specs/skr-reference.md: UserStake 169 B,
 * discriminator [102,53,163,107,9,138,87,153]; StakeConfig 193 B, share_price
 * at offset 137; staked = shares * share_price / 1e9 / 1e6) and maps its
 * result onto this shape.
 */
export async function readStakeWeight(env, wallet) {
  void env; void wallet;
  return { stakedSkr: null, checkedAt: new Date().toISOString(), source: 'stub' };
}
