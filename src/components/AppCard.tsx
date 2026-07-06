import React from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { DappEntry } from '../lib/types';
import { colors, freshness } from '../theme';

export function AppCard({ app }: { app: DappEntry }) {
  const fresh = freshness(app.lastUpdated);
  return (
    <Pressable
      style={styles.card}
      onPress={() => Linking.openURL(`solanadappstore://details?id=${app.id}`)}
    >
      <View style={styles.row}>
        <Text style={styles.name}>{app.name}</Text>
        <View style={[styles.badge, { borderColor: fresh.color }]}>
          <Text style={[styles.badgeText, { color: fresh.color }]}>
            {fresh.label}
          </Text>
        </View>
        {app.seedVaultNative && (
          <View style={[styles.badge, { borderColor: colors.purple }]}>
            <Text style={[styles.badgeText, { color: colors.purple }]}>
              Seed Vault
            </Text>
          </View>
        )}
      </View>
      <Text style={styles.desc}>{app.subtitle || app.description}</Text>
      <Text style={styles.meta}>
        ★ {app.rating.toFixed(1)} ({app.reviews.toLocaleString()}) ·{' '}
        {app.category} · updated {app.lastUpdated}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { color: colors.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  badge: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: { fontSize: 10, fontWeight: '700' },
  desc: { color: colors.textDim, marginTop: 6, fontSize: 13 },
  meta: { color: colors.textDim, marginTop: 6, fontSize: 11 },
});
