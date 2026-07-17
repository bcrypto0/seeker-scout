import React, { useState } from 'react';
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
  verifyGenesisToken,
  VerifyResult,
} from '../lib/wallet';
import { colors, heading } from '../theme';

type Verify = VerifyResult | 'checking' | undefined;

export function ProfileScreen() {
  const [address, setAddress] = useState<string>();
  const [authToken, setAuthToken] = useState<string>();
  const [verify, setVerify] = useState<Verify>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function onConnect() {
    setError(undefined);
    setBusy(true);
    try {
      const conn = await connectWallet();
      setAddress(conn.address);
      setAuthToken(conn.authToken);
      setVerify('checking');
      const result = await verifyGenesisToken(conn.address);
      if (result === 'verified') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
          .catch(() => {});
      }
      setVerify(result);
    } catch (e: any) {
      // MWA throws if the user dismisses the wallet prompt.
      setError(e?.message ? String(e.message) : 'Connection cancelled.');
    } finally {
      setBusy(false);
    }
  }

  function onDisconnect() {
    setAddress(undefined);
    setAuthToken(undefined);
    setVerify(undefined);
    setError(undefined);
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
});
