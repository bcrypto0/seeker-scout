import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { PressableCard } from '../components/PressableCard';
import { SkeletonList } from '../components/Skeleton';
import {
  ALPHA_PERIOD_DAYS,
  ALPHA_PRICE_USDC,
  alphaErrorStatus,
  authAlpha,
  cachedAlphaToken,
  cachedPendingTx,
  clearAlphaToken,
  clearPendingTx,
  getAlphaStatus,
  getFeed,
  getTeaser,
  isAuthError,
  isAwaitingFirstPreview,
  isClaimRequiredError,
  isDigestEmpty,
  isSalesClosedError,
  isTreasuryConfigured,
  resolvePaymentTerms,
  savePendingTx,
  subscribeAlpha,
} from '../lib/alpha';
import { connectWallet, findGenesisToken, payAlpha } from '../lib/wallet';
import {
  AlphaCatalyst,
  AlphaDigest,
  AlphaEntitlement,
  AlphaFreshness,
  AlphaListing,
  AlphaSession,
  AlphaSmartMoney,
  AlphaUnlock,
  AlphaWalletRow,
} from '../lib/types';
import { colors, fonts, heading } from '../theme';

/** Set once at module load — the treasury is a build-time constant. */
const TREASURY_READY = isTreasuryConfigured();

/**
 * Shown when the worker says our bearer no longer entitles us (401/402/403),
 * which for a paying subscriber is simply the end of their 30 days.
 */
const LAPSED_MESSAGE =
  'Your Alpha access has lapsed — unlock again to keep reading the live feed.';

/**
 * Turn a sign-in failure into something a Seeker owner can act on. The one
 * case worth rewording is the worker's "claim your founding number first",
 * whose remedy lives on a different tab entirely.
 */
function describeAuthFailure(e: any): string {
  if (isClaimRequiredError(e)) {
    return 'Alpha needs your Owners’ Lounge number first — it’s free and takes one tap on the Lounge tab.';
  }
  return e?.message ? String(e.message) : 'Connection cancelled.';
}

type Busy = '' | 'connect' | 'pay' | 'confirm' | 'feed';

type Authed = {
  address: string;
  authToken: string;
  mint: string;
  session: AlphaSession;
};

/**
 * Alpha (spec §3) — the War Room's intel, sold as INFORMATION only. Everyone
 * sees the delayed, partly-redacted teaser; verified Seeker owners who are
 * Lounge founders (or who pay in USDC) see the live digest.
 *
 * Three rules this screen never bends: freshness is reported honestly (a stale
 * bot says "bot offline", never "live"), no payment is ever attempted against
 * an unconfigured treasury, and no payment is ever attempted on terms the
 * worker has already told us it will refuse.
 */
export function AlphaScreen() {
  const nav = useNavigation<any>();
  const [teaser, setTeaser] = useState<AlphaDigest | null>(null);
  const [feed, setFeed] = useState<AlphaDigest | null>(null);
  const [session, setSession] = useState<AlphaSession | null>(null);
  const [entitlement, setEntitlement] = useState<AlphaEntitlement | null>(null);
  const [address, setAddress] = useState<string>();
  const [authToken, setAuthToken] = useState<string>();
  const [mint, setMint] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<Busy>('');
  const [error, setError] = useState<string>();
  // True when the worker refused us for lacking a Lounge claim — the remedy
  // lives on another tab, so the gate card offers the route rather than
  // echoing worker jargon at a dead end.
  const [claimNeeded, setClaimNeeded] = useState(false);
  // Mirrors paidSigRef for rendering: a paid-but-unactivated payment gets its
  // own CTA so the user knows a tap (not another payment) is what's missing.
  const [pendingPay, setPendingPay] = useState(false);

  // Session sequence: bumped on every user-initiated flow so a late-resolving
  // wallet/network step from an older attempt can't clobber current state.
  const sessionRef = useRef(0);
  // Hard re-entrancy latch — double-tapping "Unlock" must never send two
  // payments, and unlike `busy` a ref is current within the same tick.
  const claimingRef = useRef(false);
  // A payment that succeeded but whose /alpha/subscribe call failed. Kept so
  // the retry re-uses the SAME signature instead of charging the user twice.
  // Mirrored to AsyncStorage (savePendingTx) because the very next step
  // re-opens the wallet app, and a backgrounded RN process can be killed —
  // an in-memory-only record would strand the user's USDC.
  const paidSigRef = useRef<string | null>(null);
  // The wallet that made that payment. The worker rejects a redemption
  // presented by anyone else, so a signature must never be re-submitted under
  // a different wallet — that turns a recoverable payment into a 403 loop.
  const paidWalletRef = useRef<string | null>(null);

  /** Record a landed payment in both places, in the order that matters. */
  const rememberPayment = useCallback(
    async (signature: string, wallet: string) => {
      paidSigRef.current = signature;
      paidWalletRef.current = wallet;
      setPendingPay(true);
      await savePendingTx({ signature, wallet, ts: Date.now() });
    },
    [],
  );

  /** Forget it — only ever on a terminal verdict for that signature. */
  const forgetPayment = useCallback(async () => {
    paidSigRef.current = null;
    paidWalletRef.current = null;
    setPendingPay(false);
    await clearPendingTx();
  }, []);

  /** The stored signature, but only for the wallet that actually paid it. */
  const paymentFor = useCallback(
    (wallet: string): string | null =>
      paidSigRef.current && paidWalletRef.current === wallet
        ? paidSigRef.current
        : null,
    [],
  );

  const loadTeaser = useCallback(async () => {
    const t = await getTeaser();
    return t;
  }, []);

  // Cold start: pull the public teaser and, if a cached bearer is still
  // entitled, the live feed — neither needs a wallet prompt.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [t, cached, pending] = await Promise.all([
        loadTeaser(),
        cachedAlphaToken(),
        cachedPendingTx(),
      ]);
      if (!alive) return;
      setTeaser(t);
      // A payment that survived a process death. Load it into the retry path
      // but NEVER auto-redeem: subscribeAlpha signs a message, which would
      // throw an unrequested Seed Vault prompt at someone who just opened the
      // tab. Only adopt it for the wallet that actually paid — the worker
      // rejects a redemption presented by anyone else.
      if (pending && (!cached?.wallet || cached.wallet === pending.wallet)) {
        paidSigRef.current = pending.signature;
        paidWalletRef.current = pending.wallet;
        setPendingPay(true);
      }
      if (cached) {
        setSession(cached);
        if (cached.wallet) setAddress(cached.wallet);
        if (cached.alpha) {
          try {
            const f = await getFeed(cached.token);
            if (alive) setFeed(f);
          } catch (e) {
            if (isAuthError(e)) {
              await clearAlphaToken();
              if (alive) setSession(null);
            }
            // A failed feed load is not an error worth shouting about on cold
            // start — the teaser is already on screen and the gate card will
            // offer the retry.
          }
        }
      }
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [loadTeaser]);

  // The teaser is the whole marketing surface — one failed fetch must not
  // hide it for the rest of the session. Retry on focus until we have it.
  // Gated on `loading` so the cold-start fetch isn't duplicated on mount.
  useFocusEffect(
    useCallback(() => {
      if (!loading && !teaser) loadTeaser().then((t) => t && setTeaser(t));
    }, [loading, teaser, loadTeaser]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const seq = sessionRef.current;
    try {
      const t = await loadTeaser();
      if (sessionRef.current === seq && t) setTeaser(t);
      if (session?.alpha) {
        try {
          const f = await getFeed(session.token);
          if (sessionRef.current === seq) setFeed(f);
        } catch (e) {
          if (isAuthError(e)) {
            await clearAlphaToken();
            if (sessionRef.current === seq) {
              setSession(null);
              setFeed(null);
              // Without this the card silently flips from ALPHA ACTIVE to
              // "Connect wallet" with no explanation of what changed.
              setError(LAPSED_MESSAGE);
            }
          }
        }
      }
    } finally {
      setRefreshing(false);
    }
  }, [loadTeaser, session]);

  /** Connect → verify Genesis → Alpha bearer. null = a newer flow took over. */
  async function authFlow(seq: number): Promise<Authed | null> {
    const conn = await connectWallet();
    if (sessionRef.current !== seq) return null;
    setAddress(conn.address);
    setAuthToken(conn.authToken);

    const genesis = await findGenesisToken(conn.address);
    if (sessionRef.current !== seq) return null;
    if (genesis.status === 'not-found') {
      throw new Error(
        'No Genesis Token in this wallet — Alpha is for verified Seeker owners.',
      );
    }
    if (genesis.status !== 'verified' || !genesis.mint) {
      throw new Error("Couldn't reach the network to verify your Seeker — try again.");
    }
    setMint(genesis.mint);

    const authed = await authAlpha(conn.address, conn.authToken, genesis.mint);
    if (sessionRef.current !== seq) return null;
    setSession(authed);
    getAlphaStatus(conn.address).then((s) => {
      if (sessionRef.current === seq && s) setEntitlement(s);
    });
    return {
      address: conn.address,
      authToken: conn.authToken,
      mint: genesis.mint,
      session: authed,
    };
  }

  async function loadFeed(token: string, seq: number): Promise<void> {
    try {
      const f = await getFeed(token);
      if (sessionRef.current !== seq) return;
      setFeed(f);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => {},
      );
    } catch (e: any) {
      // 401/402/403: the bearer no longer entitles us. Drop the feed too —
      // leaving it would keep "ALPHA ACTIVE" on screen above a dead retry.
      const lapsed = isAuthError(e);
      if (lapsed) {
        await clearAlphaToken();
        if (sessionRef.current === seq) {
          setSession(null);
          setFeed(null);
        }
      }
      if (sessionRef.current === seq) {
        setError(
          lapsed
            ? LAPSED_MESSAGE
            : e?.message
              ? String(e.message)
              : "Couldn't load the live feed — try again.",
        );
      }
    }
  }

  /**
   * Retry the live feed for an already-entitled session. Uses the cached
   * bearer, so an RPC/worker hiccup costs a tap — not another Seed Vault
   * prompt and certainly not another payment.
   */
  async function onRetryFeed() {
    if (!session?.alpha) return;
    if (claimingRef.current) return;
    claimingRef.current = true;
    const seq = ++sessionRef.current;
    setError(undefined);
    setBusy('feed');
    try {
      await loadFeed(session.token, seq);
    } finally {
      claimingRef.current = false;
      if (sessionRef.current === seq) setBusy('');
    }
  }

  /** Sign in only — used by the "Connect wallet" CTA. */
  async function onConnect() {
    if (claimingRef.current) return;
    claimingRef.current = true;
    const seq = ++sessionRef.current;
    setError(undefined);
    setClaimNeeded(false);
    setBusy('connect');
    try {
      const authed = await authFlow(seq);
      if (!authed) return;
      if (authed.session.alpha) await loadFeed(authed.session.token, seq);
    } catch (e: any) {
      if (sessionRef.current === seq) {
        setClaimNeeded(isClaimRequiredError(e));
        setError(describeAuthFailure(e));
      }
    } finally {
      claimingRef.current = false;
      if (sessionRef.current === seq) setBusy('');
    }
  }

  /**
   * The paid path: (connect if needed) → USDC transfer → worker verifies it on
   * chain → re-auth for an entitled bearer → live feed. A payment that already
   * landed is never repeated; the stored signature is retried instead.
   */
  async function onUnlock() {
    // Belt and braces: the button is disabled without a treasury, and this
    // returns before any wallet prompt even if that ever regresses.
    if (!TREASURY_READY) return;
    if (claimingRef.current) return;
    claimingRef.current = true;
    const seq = ++sessionRef.current;
    const existing: Authed | null =
      address && authToken && mint && session
        ? { address, authToken, mint, session }
        : null;
    setError(undefined);
    setClaimNeeded(false);
    setBusy(paidSigRef.current ? 'confirm' : existing ? 'pay' : 'connect');
    try {
      const authed = existing ?? (await authFlow(seq));
      if (!authed) return;

      if (authed.session.alpha) {
        // Founding member, or a sub that is already active.
        await loadFeed(authed.session.token, seq);
        return;
      }
      if (authed.session.tier === 'founding') {
        // Never charge a founder — their access is a gift; something upstream
        // just failed to confirm it.
        throw new Error(
          `You're Founder #${authed.session.number ?? '—'} — Alpha is free for founders, but we couldn't confirm it just now. Try again in a moment.`,
        );
      }

      // Never charge twice. If a previous attempt's /alpha/subscribe actually
      // landed but its response never reached us — or the wallet was comped —
      // the worker already knows, and re-auth is all that's missing.
      const known = await getAlphaStatus(authed.address);
      if (sessionRef.current !== seq) return;
      if (known) setEntitlement(known);
      if (known?.active) {
        await forgetPayment();
        setBusy('confirm');
        const already = await authAlpha(
          authed.address,
          authed.authToken,
          authed.mint,
        );
        if (sessionRef.current !== seq) return;
        setSession(already);
        if (already.alpha) await loadFeed(already.token, seq);
        return;
      }

      // Only OUR payment counts: a signature from another wallet would be
      // 403'd by the worker forever, so fall through to a fresh payment.
      let signature = paymentFor(authed.address);
      if (!signature) {
        // LAST GATE BEFORE THE MONEY MOVES. The worker refuses a sale it
        // disagrees with (stale feed, rotated treasury, changed price) only
        // AFTER the USDC has left the wallet, so every disagreement has to be
        // caught here. `known` is the read we made moments ago — deliberately
        // not the session, whose cached copy can be up to 23h old. It fails
        // CLOSED when unreadable: refusing costs a deferred sale, proceeding
        // costs the user 9.99 USDC they can't spend.
        const terms = resolvePaymentTerms(known);
        if ('error' in terms) throw new Error(terms.error);
        setBusy('pay');
        signature = await payAlpha(
          authed.address,
          authed.authToken,
          terms.treasury,
          terms.price,
        );
        await rememberPayment(signature, authed.address);
      }
      if (sessionRef.current !== seq) return;

      setBusy('confirm');
      const granted = await subscribeAlpha(
        authed.address,
        authed.authToken,
        authed.mint,
        signature,
      );
      await forgetPayment(); // consumed — a retry from here re-pays
      if (sessionRef.current !== seq) return;
      setEntitlement(granted);

      const fresh = await authAlpha(authed.address, authed.authToken, authed.mint);
      if (sessionRef.current !== seq) return;
      setSession(fresh);
      if (fresh.alpha) await loadFeed(fresh.token, seq);
    } catch (e: any) {
      // A verdict that permanently settles this signature must not leave a
      // pending record behind, or the user is stuck on "your payment went
      // through" forever. 400 = this transaction can never be redeemed
      // (failed on chain / wrong destination / underpaid); 409 without the
      // sales flag = already consumed. Everything else — the stale-feed 409,
      // 404 not-confirmed-yet, 502/503, network, timeout — left the signature
      // redeemable, so we keep it. When in doubt we KEEP: a stuck retry
      // message is recoverable, a forgotten payment is money.
      const status = alphaErrorStatus(e);
      const salesClosed = isSalesClosedError(e);
      const settled = status === 400 || (status === 409 && !salesClosed);
      if (settled) await forgetPayment();
      // Flip the gate closed so the CTA stops offering a purchase the worker
      // has just told us it will refuse.
      if (salesClosed) {
        setEntitlement((prev) => (prev ? { ...prev, sales_open: false } : prev));
      }
      if (sessionRef.current === seq) {
        const base = e?.message ? String(e.message) : 'Unlock failed — try again.';
        setClaimNeeded(isClaimRequiredError(e));
        setError(
          !paidSigRef.current
            ? base
            : salesClosed
              ? `${base}\n\nYour ${ALPHA_PRICE_USDC} USDC is safe and has NOT been used — we'll honour it the moment the feed is live again. Nothing more to do right now.`
              : `${base}\n\nYour payment went through — tap again to finish activating. You will not be charged twice.`,
        );
      }
    } finally {
      claimingRef.current = false;
      if (sessionRef.current === seq) setBusy('');
    }
  }

  const digest = feed ?? teaser;
  const entitled = !!feed;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.purple]}
            progressBackgroundColor={colors.card}
          />
        }
      >
        <Text style={styles.h1}>Alpha</Text>
        <Text style={styles.sub}>
          Exchange listing radar, smart-money clusters and wallet grades —
          straight from the intel feed we trade on ourselves.
        </Text>

        {digest && <FreshnessBanner digest={digest} entitled={entitled} />}

        <GateCard
          entitled={entitled}
          session={session}
          entitlement={entitlement}
          digest={digest}
          busy={busy}
          error={error}
          claimNeeded={claimNeeded}
          pendingPay={pendingPay}
          onConnect={onConnect}
          onUnlock={onUnlock}
          onRetryFeed={onRetryFeed}
          onClaim={() => nav.navigate('Lounge')}
        />

        {loading && !digest ? (
          <View style={{ marginTop: 12 }}>
            <SkeletonList rows={4} />
          </View>
        ) : !digest ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>◆</Text>
            <Text style={styles.emptyText}>
              Couldn't load the intel digest. Pull down to try again.
            </Text>
          </View>
        ) : isDigestEmpty(digest) ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>◆</Text>
            <Text style={styles.emptyText}>
              {/* Three genuinely different answers, and conflating them reads
                  as a dead feature on launch day (caught on device 2026-07-30):
                  (a) a real digest with no rows, (b) digests ARE publishing but
                  none has aged into the ≥24h free window yet — feed_status is a
                  real status while available is false, (c) nothing ever sent. */}
              {digest.available
                ? 'Nothing fired in this window — no cluster buys, no listings, no catalysts. An empty digest is a real answer, not a loading state.'
                : isAwaitingFirstPreview(digest)
                  ? 'The intel feed is publishing. The free preview runs a day behind the live one, so the first one lands tomorrow — members see today’s now.'
                  : "The intel feed isn't publishing yet — nothing has reached Alpha so far. Pull down to check again."}
            </Text>
          </View>
        ) : (
          <>
            <AtAGlance digest={digest} />
            {/* Listing Radar leads (2026-08-09). It is the one signal here
                that no free tool reproduces — a 5-minute poll of exchange
                coin-config state, with 99 days of public history behind it.
                Smart-money clusters on fresh pump.fun mints are commodity by
                comparison, and burying the differentiated feed under them was
                why the tab read as noise. */}
            <ListingSection digest={digest} locked={!entitled} />
            <SmartMoneySection digest={digest} locked={!entitled} />
            <LeaderboardSection digest={digest} locked={!entitled} />
            <CatalystSection digest={digest} locked={!entitled} />
            <UnlockSection digest={digest} locked={!entitled} />
          </>
        )}

        <Text style={styles.disclaimer}>
          Informational only. Not financial advice. Seeker Scout never executes
          trades and never holds your funds.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

/* ------------------------------ gate card ------------------------------- */

function GateCard({
  entitled,
  session,
  entitlement,
  digest,
  busy,
  error,
  claimNeeded,
  pendingPay,
  onConnect,
  onUnlock,
  onRetryFeed,
  onClaim,
}: {
  entitled: boolean;
  session: AlphaSession | null;
  entitlement: AlphaEntitlement | null;
  digest: AlphaDigest | null;
  busy: Busy;
  error?: string;
  claimNeeded: boolean;
  pendingPay: boolean;
  onConnect: () => void;
  onUnlock: () => void;
  onRetryFeed: () => void;
  onClaim: () => void;
}) {
  const working = busy !== '';
  const label =
    busy === 'pay'
      ? 'Approve the payment in your wallet…'
      : busy === 'confirm'
        ? 'Confirming on chain…'
        : busy === 'feed'
          ? 'Loading the live feed…'
          : 'Connecting…';

  const founderFree = session?.tier === 'founding' && session.number !== null;

  // The worker refuses new paid subs whenever its stored digest isn't live,
  // and it says so on every response we already fetch. Freshest source wins:
  // the entitlement is re-read on every unlock attempt, the teaser on every
  // mount and pull-to-refresh, and the session only last — its cached copy
  // can be up to 23h old and must not close a gate that has since reopened.
  // Treat only an explicit `false` as closed; an older worker that omits the
  // field is unknown, not shut. Founders are never gated — their access is
  // free, and the worker issues it regardless of feed state.
  const salesOpen =
    entitlement?.sales_open ?? digest?.sales_open ?? session?.sales_open ?? null;
  const salesClosed = salesOpen === false;
  const feedState =
    entitlement?.feed_status ??
    digest?.feed_status ??
    session?.feed_status ??
    null;
  const feedWord = feedState && feedState !== 'unknown' ? feedState : 'not live';

  let body: React.ReactNode;
  if (entitled || session?.alpha) {
    body = (
      <>
        <View style={styles.activeBadge}>
          <Text style={styles.activeText}>
            {founderFree ? `FREE — FOUNDER #${session?.number}` : 'ALPHA ACTIVE'}
          </Text>
          <Text style={styles.activeSub}>
            {founderFree
              ? 'Founding members read the live feed at no cost.'
              : entitlement?.paid_until
                ? `Live feed unlocked through ${entitlement.paid_until.slice(0, 10)}`
                : 'Live feed unlocked'}
          </Text>
        </View>
        {!entitled && (
          <Pressable
            style={[styles.btn, working && styles.btnDim]}
            onPress={onRetryFeed}
            disabled={working}
          >
            {working ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <Text style={styles.btnText}>Load the live feed</Text>
            )}
          </Pressable>
        )}
      </>
    );
  } else if (!TREASURY_READY) {
    body = (
      <>
        <Text style={styles.gateBody}>
          Alpha unlocks here as soon as our payment wallet is live. Everything
          below is the free preview — delayed, and partly hidden.
        </Text>
        <View style={[styles.btn, styles.btnDisabled]}>
          <Text style={[styles.btnText, { color: colors.textDim }]}>
            Unlocking soon
          </Text>
        </View>
      </>
    );
  } else if (!session) {
    body = (
      <>
        <Text style={styles.gateBody}>
          Connect your Seeker wallet to check your access. Lounge founders
          (#1–100) read Alpha free; everyone else unlocks it for{' '}
          {ALPHA_PRICE_USDC} USDC per {ALPHA_PERIOD_DAYS} days, whenever the
          feed is live.
        </Text>
        <Pressable
          style={[styles.btn, working && styles.btnDim]}
          onPress={onConnect}
          disabled={working}
        >
          {working ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Text style={styles.btnText}>Connect wallet</Text>
          )}
        </Pressable>
      </>
    );
  } else if (salesClosed && !founderFree && !pendingPay) {
    // We do not sell a feed that isn't live — and we say so instead of taking
    // the money and letting the worker refuse it after the USDC has moved.
    body = (
      <>
        <Text style={styles.gateBody}>
          Alpha is paused while our feed is {feedWord} — we only sell live
          intel, so there's nothing to buy right now. The free preview below
          stays open, and unlocking returns the moment the feed is back.
        </Text>
        <View style={[styles.btn, styles.btnDisabled]}>
          <Text style={[styles.btnText, { color: colors.textDim }]}>
            Unlock paused — feed is {feedWord}
          </Text>
        </View>
      </>
    );
  } else {
    body = (
      <>
        <Text style={styles.gateBody}>
          {founderFree
            ? `You're Founder #${session.number} — Alpha is free for you.`
            : pendingPay
              ? `Your ${ALPHA_PRICE_USDC} USDC payment landed but access wasn't activated. Tap below to finish — you will not be charged again.`
              : `Unlock the live digest: the full leaderboard, every cluster buy, and pre-listing flags as they land.`}
        </Text>
        <Pressable
          style={[styles.btn, working && styles.btnDim]}
          onPress={onUnlock}
          disabled={working}
        >
          {working ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Text style={styles.btnText}>
              {founderFree
                ? 'Open your free access'
                : pendingPay
                  ? 'Finish activating your payment'
                  : `Unlock — ${ALPHA_PRICE_USDC} USDC / ${ALPHA_PERIOD_DAYS} days`}
            </Text>
          )}
        </Pressable>
        {!founderFree && !pendingPay && (
          <Text style={styles.gateFine}>
            One USDC transfer to our wallet. No subscription, no auto-renew, no
            custody — it simply lapses after {ALPHA_PERIOD_DAYS} days.
          </Text>
        )}
      </>
    );
  }

  return (
    <View style={styles.gate}>
      <Text style={styles.gateLabel}>ALPHA ACCESS</Text>
      {body}
      {working && <Text style={styles.working}>{label}</Text>}
      {!!error && <Text style={styles.err}>{error}</Text>}
      {claimNeeded && (
        <Pressable
          style={[styles.btn, styles.btnSecondary]}
          onPress={onClaim}
          disabled={working}
        >
          <Text style={styles.btnText}>Claim your Lounge number</Text>
        </Pressable>
      )}
    </View>
  );
}

/* ----------------------------- freshness -------------------------------- */

/**
 * Age of the DATA, not of the digest build. `generated_ts` is when the
 * exporter last ran, so feeding it to the banner would report a 19-day-old
 * feed as "just now". Take the WORST age we can actually measure — the same
 * rule the exporter uses to pick `status`. 0 → since() says "an unknown
 * time", which is the honest answer when nothing is measurable.
 */
function dataAgeTs(f: AlphaFreshness): number {
  const stamps: number[] = [];
  if (f.newest_signal_ts && f.newest_signal_ts > 0) {
    stamps.push(toMs(f.newest_signal_ts));
  }
  const stale = f.oldest_source_stale_seconds;
  if (stale !== null && Number.isFinite(stale) && stale >= 0) {
    stamps.push(Date.now() - stale * 1000);
  }
  if (stamps.length === 0) return 0;
  return Math.floor(Math.min(...stamps) / 1000);
}

/** Rank a status for "take the worse of the two" comparisons. */
const staleness = (s: string): number => (s === 'live' ? 0 : s === 'stale' ? 1 : 2);

function FreshnessBanner({
  digest,
  entitled,
}: {
  digest: AlphaDigest;
  entitled: boolean;
}) {
  const { status, bot_running } = digest.freshness;
  const preview = !entitled || digest.teaser;
  const known = digest.available;

  // A preview is a deliberately delayed snapshot, so it never earns the live
  // badge — and if the CURRENT feed is worse than the snapshot was, report
  // the worse of the two. Entitled members keep the digest's own honest
  // status, which is what the worker serves them.
  const effective = !known
    ? 'unknown'
    : preview
      ? staleness(digest.feed_status ?? status) >= 2
        ? 'degraded'
        : 'stale'
      : status;

  const tone =
    effective === 'live'
      ? colors.green
      : effective === 'stale'
        ? colors.yellow
        : effective === 'degraded'
          ? colors.red
          : colors.textDim;

  const dataTs = dataAgeTs(digest.freshness);
  const offline = preview
    ? digest.feed_status !== undefined && digest.feed_status !== 'live'
    : !bot_running;

  const awaiting = isAwaitingFirstPreview(digest);
  const headline = !known
    ? awaiting
      ? 'Free preview publishes tomorrow'
      : 'No digest published yet'
    : preview
      ? `${digest.delayed ? 'Delayed preview' : 'Preview'} · data from ${since(dataTs)}${offline ? ' · bot offline' : ''}`
      : status === 'live'
        ? `Live · updated ${since(digest.generated_ts)}`
        : `As of ${since(dataTs)}${bot_running ? '' : ' · bot offline'}`;

  return (
    <View style={[styles.fresh, { borderColor: tone }]}>
      <View style={[styles.dot, { backgroundColor: tone }]} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.freshText, { color: tone }]}>{headline}</Text>
        <Text style={styles.freshSub}>
          {!known
            ? awaiting
              ? 'Members are reading today’s digest now.'
              : 'Nothing has been sent to Alpha so far.'
            : entitled
              ? 'Live digest — the full feed.'
              : digest.delayed
                ? 'Free preview — yesterday’s digest, trimmed and partly hidden.'
                : 'Free preview — the latest digest, trimmed and partly hidden.'}
        </Text>
        {known && status !== 'live' && !!digest.generated_ts && (
          <Text style={styles.freshSub}>
            Digest built {since(digest.generated_ts)}.
          </Text>
        )}
      </View>
    </View>
  );
}

/* ------------------------------ sections -------------------------------- */

/**
 * Section chrome. `blurb` is not decoration — it is the fix for the tab's
 * biggest problem (2026-08-09): every section was a wall of jargon
 * ("PRE_LISTING · listing_events", "UNGRADED · hidden · — · —") that assumed
 * the reader already knew what the War Room measures. The founder, who built
 * it, could not read his own feed. One plain line per section explaining what
 * the rows ARE and what they are not is the difference between intel and noise.
 */
function SectionHeader({
  title,
  blurb,
  shown,
  total,
  locked,
}: {
  title: string;
  blurb?: string;
  shown: number;
  total: number;
  locked: boolean;
}) {
  const hidden = Math.max(0, total - shown);
  return (
    <>
      <View style={styles.sectionRow}>
        <Text style={styles.section}>
          {title} ({total})
        </Text>
        {locked && hidden > 0 && (
          <Text style={styles.lockChip}>🔒 {hidden} more</Text>
        )}
      </View>
      {!!blurb && <Text style={styles.sectionBlurb}>{blurb}</Text>}
    </>
  );
}

/**
 * One line answering "is there anything here for me?" before any scrolling.
 * Counts come from `counts` (the pre-redaction totals) so the free preview
 * reports what actually fired, not what survived the trim.
 */
function AtAGlance({ digest }: { digest: AlphaDigest }) {
  const parts: string[] = [];
  const listings = digest.counts.listing_radar ?? digest.listing_radar.length;
  if (listings > 0) {
    // `counts` are PRE-redaction totals; the arrays are post-trim (the teaser
    // ships 2 rows). Breaking "N of which are pre-listing" out of a count we
    // measured on a different population told free readers "25 events
    // (2 pre-listing)" when all 25 were pre-listing — understating the one
    // signal we actually sell. Only break it out when nothing was trimmed.
    const complete = listings === digest.listing_radar.length;
    const preListing = digest.listing_radar.filter((l) => l.is_pre_listing).length;
    // "Event", not "flip": listing_radar merges deposit-config flips with
    // Korean-exchange monitors and announcement pollers, which are not flips.
    const noun = listings === 1 ? 'event' : 'events';
    parts.push(
      complete && preListing > 0
        ? `${listings} exchange ${noun} (${preListing} pre-listing)`
        : `${listings} exchange ${noun}`,
    );
  }
  const clusters = digest.counts.smart_money ?? digest.smart_money.length;
  if (clusters > 0) {
    parts.push(`${clusters} cluster ${clusters === 1 ? 'buy' : 'buys'}`);
  }
  const catalysts = digest.counts.catalysts ?? digest.catalysts.length;
  if (catalysts > 0) {
    parts.push(`${catalysts} ${catalysts === 1 ? 'catalyst' : 'catalysts'}`);
  }
  const unlocks = digest.counts.unlock_watch ?? digest.unlock_watch.length;
  if (unlocks > 0) {
    parts.push(`${unlocks} ${unlocks === 1 ? 'unlock' : 'unlocks'} ahead`);
  }
  if (parts.length === 0) return null;

  const last = parts.pop() as string;
  const sentence = parts.length ? `${parts.join(', ')} and ${last}` : last;
  return (
    <View style={styles.glance}>
      <Text style={styles.glanceText}>
        <Text style={styles.glanceLead}>In this window: </Text>
        {sentence}.
      </Text>
    </View>
  );
}

function SmartMoneySection({
  digest,
  locked,
}: {
  digest: AlphaDigest;
  locked: boolean;
}) {
  const list = digest.smart_money;
  if (list.length === 0) return null;
  const total = digest.counts.smart_money ?? list.length;
  return (
    <>
      <SectionHeader
        title="SMART-MONEY CLUSTERS"
        blurb={
          'Wallets we track buying the same token within minutes of each other. ' +
          'We show each wallet’s grade where we have one so you can judge the cluster — a grade is a record of past trades, not a forecast.'
        }
        shown={list.length}
        total={total}
        locked={locked}
      />
      {list.map((c, i) => (
        <ClusterCard key={`${c.symbol}-${c.ts}-${i}`} cluster={c} />
      ))}
    </>
  );
}

function ClusterCard({ cluster }: { cluster: AlphaSmartMoney }) {
  // Wallets NOT SENT to us — cut by the exporter's top-N cap or the teaser's
  // trim. This is a truncation count and nothing more: a cut wallet's tier was
  // never transmitted, so it is not "ungraded", and roughly half of all graded
  // wallets are CORE. An earlier draft folded these together with the untiered
  // rows and told the reader all of them had "no closed trades on record",
  // which asserted a fact about wallets we know nothing about.
  const notShown = Math.max(0, cluster.wallet_count - cluster.top_wallets.length);
  // Guard the sentence below against a malformed row: parseSmartMoney defaults
  // wallet_count to 0 and window_sec to 0, and duration(0) returns the literal
  // "the window" — which would read "0 wallets ... within the window of each
  // other". Fall back to a sentence that stays true with either missing.
  const n = cluster.wallet_count > 0 ? cluster.wallet_count : cluster.top_wallets.length;
  const windowed = cluster.window_sec > 0;

  return (
    <PressableCard style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.symbol} numberOfLines={1}>
          {cluster.symbol}
        </Text>
        {!!cluster.grade && (
          <Text style={[styles.grade, { color: gradeColor(cluster.grade) }]}>
            {cluster.grade.toUpperCase()}
          </Text>
        )}
      </View>
      {/* Plain sentence first, machine detail second. "2 wallets · 2 buys in
          30m" is a stat line; a paying reader needs to know what HAPPENED. */}
      <Text style={styles.rowPlain}>
        <Text style={styles.numStrong}>{n}</Text>{' '}
        {n === 1 ? 'wallet we track' : 'wallets we track'} bought this
        {windowed ? ` within ${duration(cluster.window_sec)} of each other` : ''}
        {cluster.buy_count > n ? `, ${cluster.buy_count} buys in total` : ''}.
      </Text>
      <Text style={styles.cardMeta}>{since(cluster.ts)}</Text>
      {cluster.mint ? (
        <Text style={styles.mint} numberOfLines={1}>
          {shortAddr(cluster.mint)} · {cluster.chain}
        </Text>
      ) : (
        <Text style={styles.mintHidden}>mint hidden in the free preview</Text>
      )}
      {/* Every wallet row stays, ungraded ones included. An untiered wallet's
          ADDRESS is the thing a subscriber is paying for — it's checkable on
          any explorer — so hiding the row to reduce clutter would delete the
          product. Quiet the empty cells instead: an ungraded wallet has no
          closed trades we attributed, which is not a 0% win rate. */}
      {cluster.top_wallets.map((w, i) => (
        <View key={`${w.addr ?? 'x'}-${i}`} style={styles.walletRow}>
          <Text style={[styles.tier, { color: tierColor(w.tier) }]}>
            {w.tier ? w.tier.toUpperCase() : 'UNGRADED'}
          </Text>
          <Text style={styles.walletAddr} numberOfLines={1}>
            {w.addr ? shortAddr(w.addr) : 'hidden'}
          </Text>
          {w.tier && (w.win_rate !== null || w.pnl_usd !== null) ? (
            <>
              <Text style={styles.walletStat}>{pct(w.win_rate)}</Text>
              <Text style={[styles.walletStat, pnlStyle(w.pnl_usd)]}>
                {usd(w.pnl_usd)}
              </Text>
            </>
          ) : (
            <Text style={styles.walletNoRecord}>no closed trades yet</Text>
          )}
        </View>
      ))}
      {notShown > 0 && (
        <Text style={styles.walletMore}>
          +{notShown} more {notShown === 1 ? 'wallet' : 'wallets'} not shown
        </Text>
      )}
    </PressableCard>
  );
}

function LeaderboardSection({
  digest,
  locked,
}: {
  digest: AlphaDigest;
  locked: boolean;
}) {
  const list = digest.wallet_leaderboard;
  if (list.length === 0) return null;
  const total = digest.counts.wallet_leaderboard ?? list.length;
  return (
    <>
      <SectionHeader
        title="WALLET LEADERBOARD"
        blurb={
          'Every wallet ranked on trades we watched open AND close. Win rate and PnL are our own measurement, not a claim from the wallet.'
        }
        shown={list.length}
        total={total}
        locked={locked}
      />
      <View style={styles.table}>
        <View style={styles.headRow}>
          <Text style={[styles.headCell, styles.colRank]}>#</Text>
          <Text style={[styles.headCell, styles.colWallet]}>WALLET</Text>
          <Text style={[styles.headCell, styles.colStat]}>WIN</Text>
          <Text style={[styles.headCell, styles.colStat]}>PNL</Text>
        </View>
        {list.map((w, i) => (
          <LeaderRow key={`${w.addr ?? 'row'}-${i}`} row={w} rank={i + 1} />
        ))}
      </View>
    </>
  );
}

function LeaderRow({ row, rank }: { row: AlphaWalletRow; rank: number }) {
  return (
    <View style={styles.bodyRow}>
      <Text style={[styles.rank, styles.colRank]}>{rank}</Text>
      <View style={styles.colWallet}>
        <View style={styles.walletHead}>
          <Text style={[styles.tier, { color: tierColor(row.tier) }]}>
            {row.tier ? row.tier.toUpperCase() : 'UNGRADED'}
          </Text>
          {row.is_founding_vip && <Text style={styles.vip}>VIP</Text>}
        </View>
        <Text style={styles.walletAddr} numberOfLines={1}>
          {row.addr ? shortAddr(row.addr) : 'hidden in preview'}
        </Text>
        <Text style={styles.walletSub}>
          {row.wins}W / {row.losses}L
          {row.last_trade_at ? ` · ${row.last_trade_at.slice(0, 10)}` : ''}
        </Text>
      </View>
      <Text style={[styles.cell, styles.colStat]}>{pct(row.win_rate)}</Text>
      <Text style={[styles.cell, styles.colStat, pnlStyle(row.pnl_usd)]}>
        {usd(row.pnl_usd)}
      </Text>
    </View>
  );
}

function ListingSection({
  digest,
  locked,
}: {
  digest: AlphaDigest;
  locked: boolean;
}) {
  const list = digest.listing_radar;
  if (list.length === 0) return null;
  const total = digest.counts.listing_radar ?? list.length;
  return (
    <>
      <SectionHeader
        title="LISTING RADAR"
        blurb={
          'Exchanges change a coin’s deposit config before they announce a listing. We poll every 5 minutes and log each change. ' +
          'We publish no lead-time claim: our full history is public at github.com/bcrypto0/scout-alpha-log — measure it yourself.'
        }
        shown={list.length}
        total={total}
        locked={locked}
      />
      {list.map((l, i) => (
        <ListingRow key={`${l.coin}-${l.ts}-${i}`} listing={l} />
      ))}
    </>
  );
}

function ListingRow({ listing }: { listing: AlphaListing }) {
  return (
    <PressableCard style={styles.rowCard}>
      <View style={styles.cardHead}>
        <Text style={styles.symbol} numberOfLines={1}>
          {listing.coin}
        </Text>
        {listing.is_pre_listing ? (
          <Text style={styles.preListing}>PRE-LISTING</Text>
        ) : (
          <Text style={styles.exchange}>
            {listing.exchange ? listing.exchange.toUpperCase() : '—'}
          </Text>
        )}
      </View>
      {/* The raw title is exporter-speak ("gate coin-config pre-listing signal:
          SUBG"), so say what happened instead of echoing a log line.
          State ONLY the transition the detector actually tests:
          depositEnable false→true (coin_config_watcher.py). An earlier draft
          added "while withdrawals stayed closed" — the withdrawal flag is
          recorded but never tested, and 92% of real pre-listing rows have
          withdrawals OPEN, so that sentence was inventing an exchange state.
          Interpretation belongs in the section blurb; the row states fact. */}
      {listing.is_pre_listing ? (
        <Text style={styles.rowPlain}>
          <Text style={styles.numStrong}>
            {listing.exchange ? listing.exchange.toUpperCase() : 'An exchange'}
          </Text>{' '}
          switched deposits on for {listing.coin}.
        </Text>
      ) : (
        !!listing.title && (
          <Text style={styles.rowTitle} numberOfLines={2}>
            {listing.title}
          </Text>
        )
      )}
      <Text style={styles.rowMeta}>
        {[listing.exchange, listing.kind, listing.source]
          .filter(Boolean)
          .join(' · ')}
        {listing.ts ? ` · ${since(listing.ts)}` : ''}
      </Text>
    </PressableCard>
  );
}

function CatalystSection({
  digest,
  locked,
}: {
  digest: AlphaDigest;
  locked: boolean;
}) {
  const list = digest.catalysts;
  if (list.length === 0) return null;
  const total = digest.counts.catalysts ?? list.length;
  return (
    <>
      <SectionHeader
        title="CATALYSTS"
        blurb={'Dated events — mainnets, migrations, votes — ranked by our own priority weighting, not by measured price impact.'}
        shown={list.length}
        total={total}
        locked={locked}
      />
      {list.map((c, i) => (
        <CatalystRow key={`${c.symbol}-${c.ts}-${i}`} catalyst={c} />
      ))}
    </>
  );
}

function CatalystRow({ catalyst }: { catalyst: AlphaCatalyst }) {
  return (
    <PressableCard style={styles.rowCard}>
      <View style={styles.cardHead}>
        <Text style={styles.symbol} numberOfLines={1}>
          {catalyst.symbol || catalyst.type || 'Catalyst'}
        </Text>
        <Text style={styles.score}>{catalyst.score.toFixed(0)}</Text>
      </View>
      {!!catalyst.title && (
        <Text style={styles.rowTitle} numberOfLines={2}>
          {catalyst.title}
        </Text>
      )}
      <Text style={styles.rowMeta}>
        {catalyst.type}
        {catalyst.ts ? ` · ${since(catalyst.ts)}` : ''}
      </Text>
    </PressableCard>
  );
}

function UnlockSection({
  digest,
  locked,
}: {
  digest: AlphaDigest;
  locked: boolean;
}) {
  const list = digest.unlock_watch;
  if (list.length === 0) return null;
  const total = digest.counts.unlock_watch ?? list.length;
  return (
    <>
      <SectionHeader
        title="UNLOCK WATCH"
        blurb={'Scheduled token unlocks ahead. New supply hits the market on these dates — the risk you hold into, not a signal to buy.'}
        shown={list.length}
        total={total}
        locked={locked}
      />
      <View style={styles.table}>
        <View style={styles.headRow}>
          <Text style={[styles.headCell, styles.colWallet]}>COIN</Text>
          <Text style={[styles.headCell, styles.colStat]}>SUPPLY</Text>
          <Text style={[styles.headCell, styles.colStat]}>IN</Text>
        </View>
        {list.map((u, i) => (
          <UnlockRow key={`${u.coin}-${u.unlock_date}-${i}`} unlock={u} />
        ))}
      </View>
    </>
  );
}

function UnlockRow({ unlock }: { unlock: AlphaUnlock }) {
  const soon = unlock.days_until >= 0 && unlock.days_until <= 7;
  return (
    <View style={styles.bodyRow}>
      <View style={styles.colWallet}>
        <Text style={styles.symbolSm} numberOfLines={1}>
          {unlock.coin}
        </Text>
        <Text style={styles.walletSub}>{unlock.unlock_date}</Text>
      </View>
      <Text style={[styles.cell, styles.colStat]}>
        {unlock.pct_supply > 0 ? `${unlock.pct_supply.toFixed(2)}%` : '—'}
      </Text>
      <Text
        style={[styles.cell, styles.colStat, soon && { color: colors.yellow }]}
      >
        {unlock.days_until >= 0 ? `${unlock.days_until}d` : 'past'}
      </Text>
    </View>
  );
}

/* ------------------------------ formatting ------------------------------ */

/** Exporter stamps are unix SECONDS; tolerate a ms value without lying. */
const toMs = (ts: number) => (ts > 1e12 ? ts : ts * 1000);

/** "12m ago" / "6h ago" / "19d ago" — never a fabricated "just now". */
function since(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return 'an unknown time';
  const ms = Date.now() - toMs(ts);
  if (ms < 0) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function duration(seconds: number): string {
  if (!seconds || seconds <= 0) return 'the window';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/** Manual grouping — Intl is not guaranteed on every Hermes build. */
const group = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function usd(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1000) return `${sign}$${group(Math.round(abs))}`;
  return `${sign}$${abs.toFixed(abs >= 10 ? 0 : 2)}`;
}

/**
 * Win rate arrives either as a 0–1 fraction or as an already-scaled percent
 * depending on the source table, so scale only values that can't be a percent.
 */
function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const scaled = v <= 1 ? v * 100 : v;
  return `${Math.round(scaled)}%`;
}

const pnlStyle = (v: number | null) =>
  v === null || v === 0
    ? undefined
    : { color: v > 0 ? colors.green : colors.red };

const shortAddr = (a: string) =>
  a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;

/** null = a wallet we have never graded; dim it rather than guessing. */
function tierColor(tier: string | null): string {
  if (!tier) return colors.textDim;
  const k = tier.trim().toUpperCase();
  if (k.startsWith('S') || k === 'ELITE') return colors.green;
  if (k.startsWith('A') || k === 'STRONG') return colors.purple;
  if (k.startsWith('B') || k === 'GOOD') return colors.yellow;
  return colors.textDim;
}

function gradeColor(grade: string): string {
  const k = grade.trim().toUpperCase();
  if (k.startsWith('A') || k.startsWith('S')) return colors.green;
  if (k.startsWith('B')) return colors.yellow;
  if (k.startsWith('C') || k.startsWith('D') || k.startsWith('F')) return colors.red;
  return colors.textDim;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingTop: 8 },
  h1: { ...heading, paddingHorizontal: 16 },
  sub: {
    color: colors.textDim, fontSize: 13,
    paddingHorizontal: 16, marginTop: 2, marginBottom: 14, lineHeight: 18,
  },
  fresh: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: 16, marginBottom: 12,
    borderWidth: 1, borderRadius: 12, padding: 12,
    backgroundColor: colors.card,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  freshText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.3 },
  freshSub: { color: colors.textDim, fontSize: 11, marginTop: 2 },
  gate: {
    backgroundColor: colors.card, borderRadius: 18, padding: 18,
    marginHorizontal: 16, borderWidth: 1, borderColor: colors.purple,
  },
  gateLabel: {
    color: colors.purple, fontSize: 11, fontWeight: '800', letterSpacing: 1.2,
  },
  gateBody: {
    color: colors.textDim, fontSize: 13, lineHeight: 19, marginTop: 10,
  },
  gateFine: { color: colors.textDim, fontSize: 11, lineHeight: 16, marginTop: 10 },
  btn: {
    backgroundColor: colors.purple, borderRadius: 12, marginTop: 16,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center',
    minHeight: 48,
  },
  btnDim: { opacity: 0.6 },
  btnDisabled: {
    backgroundColor: colors.cardNested,
    borderWidth: 1, borderColor: colors.border,
  },
  btnSecondary: {
    backgroundColor: colors.cardNested,
    borderWidth: 1, borderColor: colors.purple, marginTop: 12,
  },
  btnText: { color: colors.text, fontWeight: '800', fontSize: 14 },
  working: { color: colors.textDim, fontSize: 12, marginTop: 10, textAlign: 'center' },
  err: { color: colors.red, fontSize: 13, marginTop: 10, lineHeight: 18 },
  activeBadge: {
    borderWidth: 1, borderColor: colors.purple, borderRadius: 14,
    marginTop: 14, paddingVertical: 16, paddingHorizontal: 12,
    alignItems: 'center',
  },
  activeText: {
    color: colors.text, fontSize: 16, fontFamily: fonts.heavy,
    fontVariant: ['tabular-nums'], textAlign: 'center',
  },
  activeSub: {
    color: colors.textDim, fontSize: 11, marginTop: 4, textAlign: 'center',
  },
  sectionRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingHorizontal: 16,
    marginTop: 22, marginBottom: 8, gap: 8,
  },
  section: {
    color: colors.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1,
    fontVariant: ['tabular-nums'], flexShrink: 1,
  },
  // Sits under a section title: smaller and dimmer than body copy so it reads
  // as a caption, but with generous line-height because it is full sentences.
  sectionBlurb: {
    color: colors.textDim, fontSize: 12, lineHeight: 17,
    paddingHorizontal: 16, marginTop: -4, marginBottom: 10,
  },
  glance: {
    marginHorizontal: 16, marginTop: 14,
    borderLeftWidth: 2, borderLeftColor: colors.purple, paddingLeft: 10,
  },
  glanceText: { color: colors.text, fontSize: 13, lineHeight: 19 },
  glanceLead: { color: colors.textDim, fontWeight: '800' },
  lockChip: {
    color: colors.purple, fontSize: 10, fontWeight: '800',
    fontVariant: ['tabular-nums'],
    borderWidth: 1, borderColor: colors.purple, borderRadius: 8,
    paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden',
  },
  card: {
    backgroundColor: colors.card, borderRadius: 14, padding: 14,
    marginHorizontal: 16, marginBottom: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  rowCard: {
    backgroundColor: colors.card, borderRadius: 14, padding: 12,
    marginHorizontal: 16, marginBottom: 8,
    borderWidth: 1, borderColor: colors.border,
  },
  cardHead: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: 8,
  },
  symbol: {
    color: colors.text, fontSize: 15, fontFamily: fonts.semi, flexShrink: 1,
  },
  symbolSm: { color: colors.text, fontSize: 13, fontFamily: fonts.semi },
  grade: {
    fontSize: 10, fontWeight: '800', letterSpacing: 0.6, flexShrink: 0,
  },
  score: {
    color: colors.purple, fontSize: 12, fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  cardMeta: {
    color: colors.textDim, fontSize: 12, marginTop: 6, lineHeight: 17,
    fontVariant: ['tabular-nums'],
  },
  numStrong: { color: colors.text, fontWeight: '800' },
  mint: {
    color: colors.textDim, fontSize: 11, marginTop: 4, fontFamily: 'monospace',
  },
  mintHidden: { color: colors.purple, fontSize: 11, marginTop: 4 },
  walletRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
    paddingTop: 8,
  },
  walletHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tier: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6, minWidth: 34 },
  vip: {
    color: colors.purple, fontSize: 9, fontWeight: '800',
    borderWidth: 1, borderColor: colors.purple, borderRadius: 6,
    paddingHorizontal: 4, overflow: 'hidden',
  },
  walletAddr: {
    color: colors.text, fontSize: 12, fontFamily: 'monospace', flex: 1,
  },
  walletSub: {
    color: colors.textDim, fontSize: 11, marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  walletStat: {
    color: colors.textDim, fontSize: 12, fontWeight: '700',
    fontVariant: ['tabular-nums'], minWidth: 52, textAlign: 'right',
  },
  /** Replaces the win/PnL cells for a wallet we have not graded. */
  walletNoRecord: {
    color: colors.textDim, fontSize: 10, fontStyle: 'italic',
    flexShrink: 0, textAlign: 'right',
  },
  walletMore: {
    color: colors.textDim, fontSize: 11, marginTop: 8,
    fontVariant: ['tabular-nums'],
  },
  table: {
    backgroundColor: colors.card, borderRadius: 14,
    marginHorizontal: 16, borderWidth: 1, borderColor: colors.border,
    overflow: 'hidden',
  },
  headRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: colors.cardNested,
  },
  headCell: {
    color: colors.textDim, fontSize: 9, fontWeight: '800', letterSpacing: 0.8,
  },
  bodyRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
  },
  colRank: { width: 20 },
  colWallet: { flex: 1 },
  colStat: { width: 62, textAlign: 'right' },
  rank: {
    color: colors.textDim, fontSize: 12, fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  cell: {
    color: colors.text, fontSize: 12, fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  rowTitle: { color: colors.text, fontSize: 13, marginTop: 6, lineHeight: 18 },
  /** The plain-English "what happened" line — the primary read on a card. */
  rowPlain: { color: colors.text, fontSize: 13, marginTop: 6, lineHeight: 19 },
  rowMeta: {
    color: colors.textDim, fontSize: 11, marginTop: 5,
    fontVariant: ['tabular-nums'],
  },
  preListing: {
    color: colors.yellow, fontSize: 9, fontWeight: '800', letterSpacing: 0.6,
    borderWidth: 1, borderColor: colors.yellow, borderRadius: 6,
    paddingHorizontal: 5, paddingVertical: 1, overflow: 'hidden', flexShrink: 0,
  },
  exchange: {
    color: colors.textDim, fontSize: 10, fontWeight: '800',
    letterSpacing: 0.6, flexShrink: 0,
  },
  empty: { alignItems: 'center', paddingHorizontal: 40, marginTop: 40 },
  emptyIcon: { color: colors.purple, fontSize: 26, marginBottom: 10 },
  emptyText: {
    color: colors.textDim, fontSize: 13, textAlign: 'center', lineHeight: 19,
  },
  disclaimer: {
    color: colors.textDim, fontSize: 11, lineHeight: 16,
    paddingHorizontal: 16, marginTop: 26, textAlign: 'center',
  },
});
