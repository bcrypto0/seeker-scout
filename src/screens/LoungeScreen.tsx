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
import { useNavigation } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
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

  useEffect(() => {
    getLoungeStats().then((s) => {
      if (s) setStats(s);
    });
  }, []);

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

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        <Text style={styles.h1}>The Lounge</Text>
        <Text style={styles.sub}>
          A members' space for verified Seeker owners only — no bots, ever.
        </Text>

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

          {claim ? (
            <View style={styles.claimBadge}>
              <Text style={styles.claimBadgeText}>{tierLabel(claim)}</Text>
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
          <Text style={styles.chatBtnText}>💬  Open the members' chat</Text>
        </Pressable>

        <Text style={styles.section}>COMING TO THE LOUNGE</Text>
        {[
          ['🎖️', 'Founding perks', 'Founder and Pioneer badges unlock early access to what ships next.'],
          ['🗳️', 'Member votes', 'Founding members help pick features and the weekly Scout Pick.'],
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingTop: 8 },
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
