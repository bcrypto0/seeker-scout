import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { connectWallet, hasGenesisToken } from '../lib/wallet';
import { colors } from '../theme';

export function ProfileScreen() {
  const [address, setAddress] = useState<string>();
  const [verified, setVerified] = useState<boolean>();
  const [busy, setBusy] = useState(false);

  async function onConnect() {
    try {
      setBusy(true);
      const addr = await connectWallet();
      setAddress(addr);
      setVerified(await hasGenesisToken(addr));
    } catch (e) {
      console.warn('connect failed', e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.root}>
      <Text style={styles.h1}>Profile</Text>
      {!address ? (
        <>
          <Text style={styles.sub}>
            Connect your Seeker wallet to verify Genesis Token ownership and
            unlock verified-owner reviews.
          </Text>
          <Pressable style={styles.btn} onPress={onConnect} disabled={busy}>
            <Text style={styles.btnText}>
              {busy ? 'Connecting…' : 'Connect Wallet'}
            </Text>
          </Pressable>
        </>
      ) : (
        <View style={styles.card}>
          <Text style={styles.addr} numberOfLines={1}>
            {address}
          </Text>
          <Text style={verified ? styles.ok : styles.warn}>
            {verified
              ? '✓ Verified Seeker owner (Genesis Token found)'
              : 'Genesis Token not found — reviews stay locked'}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingTop: 8 },
  h1: {
    color: colors.text, fontSize: 28, fontWeight: '800',
    paddingHorizontal: 16, marginBottom: 8,
  },
  sub: { color: colors.textDim, fontSize: 13, paddingHorizontal: 16 },
  btn: {
    backgroundColor: colors.purple, borderRadius: 12,
    margin: 16, paddingVertical: 14, alignItems: 'center',
  },
  btnText: { color: colors.text, fontWeight: '800', fontSize: 15 },
  card: {
    backgroundColor: colors.card, borderRadius: 14, padding: 14,
    margin: 16, borderWidth: 1, borderColor: colors.border,
  },
  addr: { color: colors.text, fontSize: 13, fontFamily: 'monospace' },
  ok: { color: colors.green, marginTop: 8, fontSize: 13 },
  warn: { color: colors.yellow, marginTop: 8, fontSize: 13 },
});
