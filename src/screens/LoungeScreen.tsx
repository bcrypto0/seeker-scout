import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { TopVouchedCard } from '../components/TopVouchedCard';
import { claimFromToken, clearToken } from '../lib/chat';
import { GameError, getToday, streakLabel, Today, untilNext } from '../lib/game';
import { setSession as setWalletSession } from '../lib/session';
import { onUnreadChange } from '../lib/unread';
import { useLoungeToken } from '../lib/useLounge';
import { connectWallet, findGenesisToken } from '../lib/wallet';
import {
  claimFounderNumber,
  getLoungeStats,
  getLoungeStatus,
  LoungeClaim,
  LoungeStats,
} from '../lib/lounge';
import { colors, fonts, heading } from '../theme';

const tierLabel = (c: LoungeClaim) =>
  c.tier === 'founding'
    ? `🏆 FOUNDER #${c.number}`
    : c.tier === 'early'
      ? `⭐ PIONEER #${c.number}`
      : `MEMBER #${c.number}`;

/**
 * The Owners' Lounge — home of the founding-number race and, soon, the
 * members' chat. Verified Seeker owners only (Genesis Token via Seed Vault).
 */
export function LoungeScreen() {
  const nav = useNavigation<any>();
  const [stats, setStats] = useState<LoungeStats | null>(null);
  const [address, setAddress] = useState<string>();
  const [authToken, setAuthToken] = useState<string>();
  const [mint, setMint] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claim, setClaim] = useState<LoungeClaim | null>(null);
  const [error, setError] = useState<string>();
  const sessionRef = useRef(0);
  const claimingRef = useRef(false);
  const lounge = useLoungeToken();
  const [today, setToday] = useState<Today | null>(null);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    getLoungeStats().then((s) => {
      if (s) setStats(s);
    });
    return onUnreadChange(setUnread);
  }, []);

  // Refresh the game status every time the tab is shown, so coming back
  // from a game shows the result instead of a stale "Play".
  useFocusEffect(
    React.useCallback(() => {
      if (!lounge.token) {
        setToday(null);
        return;
      }
      let live = true;
      getToday(lounge.token)
        .then((t) => live && setToday(t))
        .catch(async (e) => {
          if (e instanceof GameError && e.status === 401) await clearToken();
        });
      return () => {
        live = false;
      };
    }, [lounge.token]),
  );

  async function onVerify() {
    setError(undefined);
    setChecking(true);
    const session = ++sessionRef.current;
    try {
      const conn = await connectWallet();
      if (sessionRef.current !== session) return;
      setAddress(conn.address);
      setAuthToken(conn.authToken);
      const result = await findGenesisToken(conn.address);
      if (sessionRef.current !== session) return;
      // Shared with the vouch sheet, so vouching from an app page needs no second connect.
      setWalletSession({
        address: conn.address,
        authToken: conn.authToken,
        mint: result.mint,
        genesis: result.status,
      });
      if (result.status === 'verified' && result.mint) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
          .catch(() => {});
        setMint(result.mint);
        const existing = await getLoungeStatus(result.mint);
        if (sessionRef.current === session && existing) setClaim(existing);
      } else if (result.status === 'not-found') {
        setError('No Genesis Token in this wallet — the Lounge is Seeker-owners only.');
      } else {
        setError("Couldn't reach the network to verify — try again.");
      }
    } catch (e: any) {
      if (sessionRef.current === session) {
        setError(e?.message ? String(e.message) : 'Connection cancelled.');
      }
    } finally {
      if (sessionRef.current === session) setChecking(false);
    }
  }

  async function onClaim() {
    if (!address || !authToken || !mint) return;
    if (claimingRef.current) return;
    claimingRef.current = true;
    const session = sessionRef.current;
    setError(undefined);
    setClaiming(true);
    try {
      const result = await claimFounderNumber(address, authToken, mint);
      if (sessionRef.current !== session) return;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        .catch(() => {});
      setClaim(result);
      getLoungeStats().then((s) => {
        if (sessionRef.current === session && s) setStats(s);
      });
    } catch (e: any) {
      if (sessionRef.current === session) {
        setError(e?.message ? String(e.message) : 'Claim failed — try again.');
      }
    } finally {
      claimingRef.current = false;
      if (sessionRef.current === session) setClaiming(false);
    }
  }

  const founding = stats ? Math.min(stats.founding, 100) : null;
  // Signed in already means claimed (the worker refuses a token to anyone
  // without a number), so show the badge instead of asking them to verify.
  const seat = claim ?? claimFromToken(lounge.token);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        <Text style={styles.h1}>The Lounge</Text>
        <Text style={styles.sub}>
          Verified Seeker owners only. Chat, play the daily games, climb the board.
        </Text>

        <ScoutDailyCard
          today={today}
          signedIn={!!lounge.token}
          onGuess={() => nav.navigate('Guess')}
          onHol={() => nav.navigate('HigherLower')}
          onBoard={() => nav.navigate('Leaderboard')}
        />

        <View style={styles.heroCard}>
          <Text style={styles.heroLabel}>THE FOUNDING 100</Text>
          {founding !== null ? (
            <>
              <Text style={styles.heroCount}>
                {founding}
                <Text style={styles.heroTotal}> / 100 claimed</Text>
              </Text>
              <View style={styles.barTrack}>
                <View style={[styles.barFill, { width: `${founding}%` }]} />
              </View>
            </>
          ) : (
            <Text style={styles.heroTotal}>founding spots are limited to 100</Text>
          )}
          <Text style={styles.heroSub}>
            Claims #1–100 carry a permanent numbered 🏆 FOUNDER badge.
            #101–500 become ⭐ PIONEERS. One claim per Seeker, forever.
          </Text>

          {seat ? (
            <View style={styles.claimBadge}>
              <Text style={styles.claimBadgeText}>{tierLabel(seat)}</Text>
              <Text style={styles.claimBadgeSub}>permanently yours</Text>
            </View>
          ) : !mint ? (
            <Pressable
              style={[styles.btn, checking && styles.btnDim]}
              onPress={onVerify}
              disabled={checking}
            >
              {checking ? (
                <ActivityIndicator color={colors.text} />
              ) : (
                <Text style={styles.btnText}>Verify & claim your number</Text>
              )}
            </Pressable>
          ) : (
            <Pressable
              style={[styles.btn, claiming && styles.btnDim]}
              onPress={onClaim}
              disabled={claiming}
            >
              {claiming ? (
                <ActivityIndicator color={colors.text} />
              ) : (
                <Text style={styles.btnText}>Claim your founding number</Text>
              )}
            </Pressable>
          )}
          {error && <Text style={styles.err}>{error}</Text>}
        </View>

        <Pressable style={styles.chatBtn} onPress={() => nav.navigate('Chat')}>
          <Text style={styles.chatBtnText}>
            💬  Members' chat{unread > 0 ? `  ·  ${unread > 9 ? '9+' : unread} new` : ''}
          </Text>
        </Pressable>

        {/* Where the "Member votes" SOON card stood: the weekly vote was cut (plan C),
            so the Lounge shows what owners vouched for this week instead of promising it. */}
        <TopVouchedCard />

        <Text style={styles.section}>COMING TO THE LOUNGE</Text>
        {[
          ['🎖️', 'Founding perks', 'Founder and Pioneer badges unlock early access to what ships next.'],
        ].map(([icon, title, detail]) => (
          <View key={title} style={styles.roadCard}>
            <Text style={styles.roadIcon}>{icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.roadTitle}>{title}</Text>
              <Text style={styles.roadDetail}>{detail}</Text>
            </View>
            <Text style={styles.roadSoon}>SOON</Text>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * The daily games, front and centre. Signed out, it's a pitch that leads to
 * the games (which offer practice and the seat check). Signed in, each tile
 * says exactly where you are today, so the hub answers "have I played?".
 */
function ScoutDailyCard({
  today,
  signedIn,
  onGuess,
  onHol,
  onBoard,
}: {
  today: Today | null;
  signedIn: boolean;
  onGuess: () => void;
  onHol: () => void;
  onBoard: () => void;
}) {
  const g = today?.guess;
  const h = today?.hol;
  const guessStatus = !g
    ? 'Play'
    : g.done
      ? g.solved
        ? `Solved in ${g.guesses.length} ✅`
        : 'Missed today'
      : g.guesses.length
        ? `${g.maxGuesses - g.guesses.length} guesses left`
        : 'Play';
  const holStatus = !h
    ? 'Play'
    : h.done
      ? `🔥 ${h.score} today`
      : h.step
        ? `🔥 ${h.score} so far`
        : 'Play';
  return (
    <View style={styles.daily}>
      <View style={styles.dailyTop}>
        <Text style={styles.dailyLabel}>
          🧭 SCOUT DAILY{today ? ` #${today.puzzleNo}` : ''}
        </Text>
        {today && <Text style={styles.dailyNext}>new in {untilNext(today.nextAt)}</Text>}
      </View>
      <Text style={styles.dailyPitch}>
        {signedIn
          ? 'Two quick games about the dApp Store. Same puzzle for every member, once a day.'
          : 'Two daily games about the dApp Store. One run per Seeker, so the board stays fair.'}
      </Text>
      <View style={styles.tiles}>
        <Pressable style={styles.tile} onPress={onGuess}>
          <Text style={styles.tileIcon}>🔎</Text>
          <Text style={styles.tileName}>Guess the dApp</Text>
          <Text style={[styles.tileStatus, g?.done && styles.tileDone]}>{guessStatus}</Text>
        </Pressable>
        <Pressable style={styles.tile} onPress={onHol}>
          <Text style={styles.tileIcon}>⚖️</Text>
          <Text style={styles.tileName}>Higher or Lower</Text>
          <Text style={[styles.tileStatus, h?.done && styles.tileDone]}>{holStatus}</Text>
        </Pressable>
      </View>
      <Pressable style={styles.dailyFoot} onPress={onBoard}>
        <Text style={styles.dailyFootText}>
          {today
            ? `${streakLabel(today.streak)} · ${today.week.rank ? `#${today.week.rank} this week` : 'unranked this week'} · ${today.week.score} pts`
            : "This week's leaderboard"}
        </Text>
        <Text style={styles.dailyFootLink}>Board →</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingTop: 8 },
  daily: {
    backgroundColor: colors.card, borderRadius: 18, padding: 16,
    marginHorizontal: 16, marginBottom: 16, borderWidth: 1, borderColor: colors.green,
  },
  dailyTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  dailyLabel: { color: colors.green, fontSize: 11, fontWeight: '800', letterSpacing: 1.1 },
  dailyNext: { color: colors.textDim, fontSize: 11 },
  dailyPitch: { color: colors.textDim, fontSize: 13, lineHeight: 18, marginTop: 8 },
  tiles: { flexDirection: 'row', gap: 10, marginTop: 14 },
  tile: {
    flex: 1, backgroundColor: colors.cardNested, borderRadius: 14, padding: 12,
    borderWidth: 1, borderColor: colors.border,
  },
  tileIcon: { fontSize: 22 },
  tileName: { color: colors.text, fontSize: 14, fontFamily: fonts.semi, marginTop: 6 },
  tileStatus: { color: colors.purple, fontSize: 12, fontWeight: '800', marginTop: 4 },
  tileDone: { color: colors.green },
  dailyFoot: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 14, paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
  },
  dailyFootText: { color: colors.textDim, fontSize: 12, flex: 1 },
  dailyFootLink: { color: colors.green, fontSize: 12, fontWeight: '800' },
  h1: { ...heading, paddingHorizontal: 16 },
  sub: {
    color: colors.textDim, fontSize: 13,
    paddingHorizontal: 16, marginTop: 2, marginBottom: 14,
  },
  heroCard: {
    backgroundColor: colors.card, borderRadius: 18, padding: 18,
    marginHorizontal: 16, borderWidth: 1, borderColor: colors.purple,
  },
  heroLabel: {
    color: colors.purple, fontSize: 11, fontWeight: '800', letterSpacing: 1.2,
  },
  heroCount: {
    color: colors.text, fontSize: 34, fontFamily: fonts.heavy,
    marginTop: 8, fontVariant: ['tabular-nums'],
  },
  heroTotal: { color: colors.textDim, fontSize: 15, fontFamily: fonts.regular },
  barTrack: {
    height: 8, borderRadius: 4, backgroundColor: colors.cardNested,
    marginTop: 12, overflow: 'hidden',
  },
  barFill: {
    height: 8, borderRadius: 4, backgroundColor: colors.purple,
  },
  heroSub: {
    color: colors.textDim, fontSize: 13, lineHeight: 19, marginTop: 14,
  },
  btn: {
    backgroundColor: colors.purple, borderRadius: 12, marginTop: 16,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center',
    minHeight: 48,
  },
  btnDim: { opacity: 0.6 },
  btnText: { color: colors.text, fontWeight: '800', fontSize: 14 },
  err: { color: colors.red, fontSize: 13, marginTop: 10 },
  claimBadge: {
    borderWidth: 1, borderColor: colors.purple, borderRadius: 14,
    marginTop: 16, paddingVertical: 16, alignItems: 'center',
  },
  claimBadgeText: {
    color: colors.text, fontSize: 20, fontFamily: fonts.heavy,
    fontVariant: ['tabular-nums'],
  },
  claimBadgeSub: { color: colors.textDim, fontSize: 11, marginTop: 4 },
  chatBtn: {
    backgroundColor: colors.purple, borderRadius: 14,
    marginHorizontal: 16, marginTop: 16,
    paddingVertical: 15, alignItems: 'center', minHeight: 48, justifyContent: 'center',
  },
  chatBtnText: { color: colors.text, fontWeight: '800', fontSize: 15 },
  section: {
    color: colors.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1,
    paddingHorizontal: 16, marginTop: 22, marginBottom: 8,
  },
  roadCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.card, borderRadius: 14, padding: 14,
    marginHorizontal: 16, marginBottom: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  roadIcon: { fontSize: 22 },
  roadTitle: { color: colors.text, fontSize: 15, fontFamily: fonts.semi },
  roadDetail: { color: colors.textDim, fontSize: 12, marginTop: 3, lineHeight: 17 },
  roadSoon: {
    color: colors.purple, fontSize: 9, fontWeight: '800', letterSpacing: 0.8,
    borderWidth: 1, borderColor: colors.purple, borderRadius: 8,
    paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden',
  },
});
