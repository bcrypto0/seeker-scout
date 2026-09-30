import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { catOf } from '../lib/collections';
import { NOT_FOR_ME_LABEL } from '../lib/notForMeFilter';
import { DappEntry } from '../lib/types';
import { hasWorksChip, WORKS_CHIP_A11Y, WORKS_CHIP_LABEL } from '../lib/vouchStamp';
import { colors, freshness } from '../theme';
import { AppIcon } from './AppIcon';
import { DeltaChip } from './DeltaChip';
import { PressableCard } from './PressableCard';
import { WatchButton } from './WatchButton';

const NEW_WINDOW_MS = 14 * 86_400_000;

/**
 * `notForMe`: the app is on the viewer's Not for me list (Search, and the
 * Watching / To try / Hidden views, which keep such apps). `onUndo`: the
 * Hidden view's way to take it off the list again.
 */
export function AppCard({
  app,
  notForMe = false,
  onUndo,
}: {
  app: DappEntry;
  notForMe?: boolean;
  onUndo?: () => void;
}) {
  const nav = useNavigation<any>();
  const fresh = freshness(app.lastUpdated);
  const isNew =
    !!app.firstSeen && Date.now() - new Date(app.firstSeen).getTime() < NEW_WINDOW_MS;
  const works = hasWorksChip(app);
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
            {app.onchainVerified && (
              <Text style={styles.chain}>⛓</Text>
            )}
          </View>
          {/* Its own row, not the name row: that row already holds up to four
              chips beside a shrinking name, and a fifth would be cut off on a
              narrow screen. Text only, no glyph: a fallback-font glyph once
              clipped a chip (a02b023). */}
          {(works || notForMe) && (
            <View style={styles.chipRow}>
              {works && (
                <View
                  style={[styles.badge, { borderColor: colors.purple }]}
                  accessible
                  accessibilityLabel={WORKS_CHIP_A11Y}
                >
                  <Text style={[styles.badgeText, { color: colors.purple }]}>
                    {WORKS_CHIP_LABEL}
                  </Text>
                </View>
              )}
              {notForMe && (
                <View
                  style={[styles.badge, { borderColor: colors.red }]}
                  accessible
                  accessibilityLabel={`${NOT_FOR_ME_LABEL}, hidden from your Discover feed`}
                >
                  <Text style={[styles.badgeText, { color: colors.red }]}>
                    {NOT_FOR_ME_LABEL}
                  </Text>
                </View>
              )}
              {notForMe && !!onUndo && (
                <Pressable
                  onPress={onUndo}
                  hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                  style={styles.undo}
                  accessibilityRole="button"
                  accessibilityLabel={`Undo ${NOT_FOR_ME_LABEL} for ${app.name}`}
                  accessibilityHint="Shows this app in Discover again"
                >
                  <Text style={styles.undoText}>Undo</Text>
                </Pressable>
              )}
            </View>
          )}
          <Text style={styles.desc} numberOfLines={1}>
            {app.subtitle || app.description}
          </Text>
          <Text style={styles.meta}>
            ★ {app.rating.toFixed(1)} ({app.reviews.toLocaleString()}) ·{' '}
            {catOf(app)} · updated {app.lastUpdated}
          </Text>
        </View>
        <WatchButton id={app.id} size={20} />
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
  body: { flex: 1, marginLeft: 12, marginRight: 6 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  badge: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  badgeText: { fontSize: 9, fontWeight: '700' },
  // A row so the chip keeps its own width instead of stretching to the column.
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  undo: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  undoText: { color: colors.text, fontSize: 10, fontWeight: '700' },
  chain: { fontSize: 11 },
  desc: { color: colors.textDim, marginTop: 4, fontSize: 12 },
  meta: {
    color: colors.textDim,
    marginTop: 4,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
});
