import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import {
  connectWallet,
  findGenesisToken,
  VerifyResult,
} from '../lib/wallet';
import {
  claimFounderNumber,
  getLoungeStats,
  getLoungeStatus,
  LoungeClaim,
  LoungeStats,
} from '../lib/lounge';
import { colors, fonts, heading } from '../theme';

type Verify = VerifyResult | 'checking' | undefined;

export function ProfileScreen() {
  const [address, setAddress] = useState<string>();
  const [authToken, setAuthToken] = useState<string>();
  const [verify, setVerify] = useState<Verify>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [genesisMint, setGenesisMint] = useState<string>();
  const [loungeClaim, setLoungeClaim] = useState<LoungeClaim | null>(null);
  const [loungeStats, setLoungeStats] = useState<LoungeStats | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string>();
  // Session sequence: bumped on connect/disconnect so late-resolving lounge
  // promises from an older session can't clobber current state.
  const sessionRef = useRef(0);
  const claimingRef = useRef(false);

  async function onConnect() {
    setError(undefined);
    setBusy(true);
    const session = ++sessionRef.current;
    try {
      const conn = await connectWallet();
      setAddress(conn.address);
      setAuthToken(conn.authToken);
      setVerify('checking');
      const result = await findGenesisToken(conn.address);
      if (sessionRef.current !== session) return;
      if (result.status === 'verified') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
          .catch(() => {});
        setGenesisMint(result.mint);
        // Existing founding number + global stats, in the background.
        if (result.mint) {
          getLoungeStatus(result.mint).then((c) => {
            if (sessionRef.current === session && c) setLoungeClaim(c);
          });
        }
        getLoungeStats().then((s) => {
          if (sessionRef.current === session && s) setLoungeStats(s);
        });
      }
      setVerify(result.status);
    } catch (e: any) {
      // MWA throws if the user dismisses the wallet prompt.
      if (sessionRef.current === session) {
        setError(e?.message ? String(e.message) : 'Connection cancelled.');
      }
    } finally {
      if (sessionRef.current === session) setBusy(false);
    }
  }

  async function onClaim() {
    if (!address || !authToken || !genesisMint) return;
    if (claimingRef.current) return; // sync double-tap guard
    claimingRef.current = true;
    const session = sessionRef.current;
    setClaimError(undefined);
    setClaiming(true);
    try {
      const claim = await claimFounderNumber(address, authToken, genesisMint);
      if (sessionRef.current !== session) return;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        .catch(() => {});
      setLoungeClaim(claim);
      getLoungeStats().then((s) => {
        if (sessionRef.current === session && s) setLoungeStats(s);
      });
    } catch (e: any) {
      if (sessionRef.current === session) {
        setClaimError(
          e?.message ? String(e.message) : 'Claim failed — try again.',
        );
      }
    } finally {
      claimingRef.current = false;
      if (sessionRef.current === session) setClaiming(false);
    }
  }

  function onDisconnect() {
    sessionRef.current += 1;
    setAddress(undefined);
    setAuthToken(undefined);
    setVerify(undefined);
    setError(undefined);
    setGenesisMint(undefined);
    setLoungeClaim(null);
    setClaimError(undefined);
  }

  const short = address
    ? `${address.slice(0, 4)}…${address.slice(-4)}`
    : '';

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Text style={styles.h1}>Profile</Text>

      {!address ? (
        <>
          <Text style={styles.sub}>
            Connect your Seeker wallet to verify Genesis Token ownership and
            unlock verified-owner reviews.
          </Text>
          <Pressable
            style={[styles.btn, busy && styles.btnDim]}
            onPress={onConnect}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <Text style={styles.btnText}>Connect Wallet</Text>
            )}
          </Pressable>
          {error && <Text style={styles.err}>{error}</Text>}
        </>
      ) : (
        <View style={styles.card}>
          <Text style={styles.label}>CONNECTED</Text>
          <Text style={styles.addr}>{short}</Text>

          {verify === 'checking' && (
            <View style={styles.row}>
              <ActivityIndicator size="small" color={colors.textDim} />
              <Text style={styles.checking}>Checking Genesis Token…</Text>
            </View>
          )}
          {verify === 'verified' && (
            <Text style={styles.ok}>
              ✓ Verified Seeker owner — Genesis Token found
            </Text>
          )}
          {verify === 'not-found' && (
            <Text style={styles.warn}>
              No Genesis Token in this wallet — reviews stay locked
            </Text>
          )}
          {verify === 'error' && (
            <Text style={styles.warn}>
              Couldn't reach the network to verify — try again
            </Text>
          )}

          <Pressable style={styles.disconnect} onPress={onDisconnect}>
            <Text style={styles.disconnectText}>Disconnect</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.lounge}>
        <Text style={styles.loungeTitle}>THE OWNERS' LOUNGE 🔒</Text>
        <Text style={styles.loungeSub}>
          A members' space for verified Seeker owners only — no bots, ever.
          Chat is coming; founding numbers are claimable now.
        </Text>
        {loungeStats && (
          <Text style={styles.loungeStats}>
            {Math.min(loungeStats.total, 100)} of 100 founding spots claimed
          </Text>
        )}

        {loungeClaim ? (
          <View style={styles.claimBadge}>
            <Text style={styles.claimBadgeText}>
              {loungeClaim.tier === 'founding'
                ? `🏆 FOUNDER #${loungeClaim.number}`
                : loungeClaim.tier === 'early'
                  ? `⭐ EARLY MEMBER #${loungeClaim.number}`
                  : `MEMBER #${loungeClaim.number}`}
            </Text>
          </View>
        ) : verify === 'verified' && genesisMint ? (
          <>
            <Pressable
              style={[styles.claimBtn, claiming && styles.btnDim]}
              onPress={onClaim}
              disabled={claiming}
            >
              {claiming ? (
                <ActivityIndicator color={colors.text} />
              ) : (
                <Text style={styles.claimBtnText}>
                  Claim your founding number
                </Text>
              )}
            </Pressable>
            {claimError && <Text style={styles.err}>{claimError}</Text>}
          </>
        ) : (
          <Text style={styles.loungeLocked}>
            Connect and verify your Genesis Token above to claim yours.
          </Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingTop: 8 },
  h1: { ...heading, paddingHorizontal: 16, marginBottom: 8 },
  sub: { color: colors.textDim, fontSize: 13, paddingHorizontal: 16 },
  btn: {
    backgroundColor: colors.purple,
    borderRadius: 12,
    margin: 16,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  btnDim: { opacity: 0.6 },
  btnText: { color: colors.text, fontWeight: '800', fontSize: 15 },
  err: {
    color: colors.red,
    fontSize: 13,
    paddingHorizontal: 16,
    marginTop: -4,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16,
    margin: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  label: {
    color: colors.green,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  addr: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginTop: 4,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  checking: { color: colors.textDim, fontSize: 13 },
  ok: { color: colors.green, marginTop: 12, fontSize: 13, fontWeight: '600' },
  warn: { color: colors.yellow, marginTop: 12, fontSize: 13 },
  disconnect: {
    marginTop: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  disconnectText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  lounge: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16,
    marginHorizontal: 16,
    marginTop: 4,
    borderWidth: 1,
    borderColor: colors.purple,
  },
  loungeTitle: {
    color: colors.purple,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },
  loungeSub: { color: colors.textDim, fontSize: 13, marginTop: 8, lineHeight: 18 },
  loungeStats: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    marginTop: 10,
    fontVariant: ['tabular-nums'],
  },
  loungeLocked: { color: colors.textDim, fontSize: 12, marginTop: 12 },
  claimBtn: {
    backgroundColor: colors.purple,
    borderRadius: 12,
    marginTop: 14,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  claimBtnText: { color: colors.text, fontWeight: '800', fontSize: 14 },
  claimBadge: {
    borderWidth: 1,
    borderColor: colors.purple,
    borderRadius: 12,
    marginTop: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  claimBadgeText: {
    color: colors.text,
    fontSize: 16,
    fontFamily: fonts.heavy,
    fontVariant: ['tabular-nums'],
  },
});
