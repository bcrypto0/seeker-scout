import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { DappEntry } from '../lib/types';
import { colors, freshness } from '../theme';
import { AppIcon } from './AppIcon';
import { DeltaChip } from './DeltaChip';
import { PressableCard } from './PressableCard';

const NEW_WINDOW_MS = 14 * 86_400_000;

export function AppCard({ app }: { app: DappEntry }) {
  const nav = useNavigation<any>();
  const fresh = freshness(app.lastUpdated);
  const isNew =
    !!app.firstSeen && Date.now() - new Date(app.firstSeen).getTime() < NEW_WINDOW_MS;
  return (
    <PressableCard
      style={styles.card}
      onPress={() => nav.navigate('AppDetail', { app })}
    >
      <View style={styles.row}>
        <AppIcon uri={app.iconUrl} />
        <View style={styles.body}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>
              {app.name}
            </Text>
            <DeltaChip delta={app.rankDelta} />
            {/* Max two badges on a card row — NEW supersedes freshness (a
                just-listed app is fresh by definition); everything shows in
                full on the detail screen. */}
            {isNew ? (
              <View style={[styles.badge, { borderColor: colors.green }]}>
                <Text style={[styles.badgeText, { color: colors.green }]}>NEW</Text>
              </View>
            ) : (
              <View style={[styles.badge, { borderColor: fresh.color }]}>
                <Text style={[styles.badgeText, { color: fresh.color }]}>
                  {fresh.label}
                </Text>
              </View>
            )}
            {app.seedVaultNative && (
              <View style={[styles.badge, { borderColor: colors.purple }]}>
                <Text style={[styles.badgeText, { color: colors.purple }]}>
                  Seed Vault
                </Text>
              </View>
            )}
          </View>
          <Text style={styles.desc} numberOfLines={1}>
            {app.subtitle || app.description}
          </Text>
          <Text style={styles.meta}>
            ★ {app.rating.toFixed(1)} ({app.reviews.toLocaleString()}) ·{' '}
            {app.category} · updated {app.lastUpdated}
          </Text>
        </View>
      </View>
    </PressableCard>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 12,
    marginHorizontal: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  body: { flex: 1, marginLeft: 12 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  badge: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  badgeText: { fontSize: 9, fontWeight: '700' },
  desc: { color: colors.textDim, marginTop: 4, fontSize: 12 },
  meta: {
    color: colors.textDim,
    marginTop: 4,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
});
