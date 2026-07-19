import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { AdBanner } from './AdBanner';
import { AppIcon } from './AppIcon';
import { DeltaChip } from './DeltaChip';
import { PressableCard } from './PressableCard';
import { scoutPick, topClimbers } from '../lib/collections';
import { DappEntry } from '../lib/types';
import { colors, fonts } from '../theme';

/**
 * Discover header: promo banner + auto-generated Scout Pick hero + Movers
 * rail. All derived from the catalog — zero editorial cost (battle plan §7/§8).
 * Shown only on the default view (passed show=false to hide on filters).
 */
export function DiscoverHeader({
  apps,
  show,
}: {
  apps: DappEntry[];
  show: boolean;
}) {
  const nav = useNavigation<any>();
  const pick = show ? scoutPick(apps) : undefined;
  const climbers = show ? topClimbers(apps, 12) : [];

  return (
    <View>
      <AdBanner />
      {pick && (
        <>
          <Text style={styles.eyebrow}>✦ SCOUT PICK</Text>
          <PressableCard
            style={styles.hero}
            onPress={() => nav.navigate('AppDetail', { app: pick })}
          >
            <AppIcon uri={pick.iconUrl} size={56} />
            <View style={styles.heroBody}>
              <Text style={styles.heroName} numberOfLines={1}>{pick.name}</Text>
              <Text style={styles.heroDesc} numberOfLines={2}>
                {pick.subtitle || pick.description}
              </Text>
              <View style={styles.heroMeta}>
                <DeltaChip delta={pick.rankDelta} />
                <Text style={styles.heroMetaText}>
                  ★ {pick.rating.toFixed(1)} · {pick.category}
                </Text>
              </View>
            </View>
          </PressableCard>
        </>
      )}
      {climbers.length > 0 && (
        <>
          <Text style={styles.eyebrow}>📈 TOP CLIMBERS TODAY</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.rail}
          >
            {climbers.map((a) => (
              <PressableCard
                key={a.id}
                style={styles.tile}
                onPress={() => nav.navigate('AppDetail', { app: a })}
              >
                <AppIcon uri={a.iconUrl} size={44} />
                <Text style={styles.tileName} numberOfLines={1}>{a.name}</Text>
                <DeltaChip delta={a.rankDelta} />
              </PressableCard>
            ))}
          </ScrollView>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  eyebrow: {
    color: colors.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1,
    paddingHorizontal: 16, marginTop: 6, marginBottom: 8,
  },
  hero: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.card, borderRadius: 16,
    borderWidth: 1, borderColor: colors.green,
    marginHorizontal: 16, marginBottom: 6, padding: 14,
  },
  heroBody: { flex: 1, marginLeft: 12 },
  heroName: { color: colors.text, fontSize: 17, fontFamily: fonts.heavy },
  heroDesc: { color: colors.textDim, fontSize: 12, marginTop: 3, lineHeight: 16 },
  heroMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  heroMetaText: { color: colors.textDim, fontSize: 11, fontVariant: ['tabular-nums'] },
  rail: { paddingHorizontal: 16, gap: 10, paddingBottom: 4 },
  tile: {
    width: 96, backgroundColor: colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: colors.border,
    padding: 10, alignItems: 'center', gap: 6,
  },
  tileName: { color: colors.text, fontSize: 11, fontWeight: '600', textAlign: 'center' },
});
