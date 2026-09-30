import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { AdBanner } from './AdBanner';
import { AppIcon } from './AppIcon';
import { DeltaChip } from './DeltaChip';
import { PressableCard } from './PressableCard';
import { catOf, scoutPick, topClimbers } from '../lib/collections';
import { visiblePick, withoutHidden } from '../lib/notForMeFilter';
import { DappEntry } from '../lib/types';
import { ownersLine, ownersPick, WORKS_CHIP_A11Y, WORKS_CHIP_LABEL } from '../lib/vouchStamp';
import { colors, fonts } from '../theme';

const NONE: ReadonlySet<string> = new Set();

/**
 * Discover header: promo banner + auto-generated hero + Movers rail. All
 * derived from the catalog, at zero editorial cost (battle plan §7/§8).
 * Shown only on the default view (passed show=false to hide on filters).
 *
 * The hero is an app Seeker owners vouched for (vouchStamp.ownersPick,
 * shown as "Vouched by Seeker owners") when any app carries the Works on
 * Seeker chip, else the Scout Pick. With no stamped app (the offline seed,
 * a skipped stamp, or simply no chip yet) it is the Scout Pick exactly as
 * before.
 *
 * `hidden` is the viewer's Not for me list: neither pick and no climber is
 * an app on it. A hidden pick is made again over the apps left
 * (notForMeFilter.visiblePick), so hiding some other app leaves today's
 * pick where it is.
 */
export function DiscoverHeader({
  apps,
  show,
  hidden = NONE,
}: {
  apps: DappEntry[];
  show: boolean;
  hidden?: ReadonlySet<string>;
}) {
  const nav = useNavigation<any>();
  const owners = show ? visiblePick(apps, hidden, (list) => ownersPick(list)) : undefined;
  const pick = owners ?? (show ? visiblePick(apps, hidden, (list) => scoutPick(list)) : undefined);
  const climbers = show ? topClimbers(withoutHidden(apps, hidden), 12) : [];
  const vouched = owners ? ownersLine(owners) : null;

  return (
    <View>
      <AdBanner />
      {pick && (
        <>
          {/* Scout rotates this daily across the best-vouched apps: owners vouched for it, they did not pick it. */}
          <Text style={styles.eyebrow}>
            {owners ? '✦ VOUCHED BY SEEKER OWNERS' : '✦ SCOUT PICK'}
          </Text>
          <PressableCard
            style={[styles.hero, !!owners && styles.heroOwners]}
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
                <Text style={styles.heroMetaText} numberOfLines={1}>
                  {/* An owners' pick can be new to the store: no "★ 0.0" for zero reviews. */}
                  {pick.reviews > 0 ? `★ ${pick.rating.toFixed(1)} · ` : ''}
                  {catOf(pick)}
                </Text>
              </View>
              {!!owners && (
                <View style={styles.heroVouch}>
                  <View style={styles.badge} accessible accessibilityLabel={WORKS_CHIP_A11Y}>
                    <Text style={styles.badgeText}>{WORKS_CHIP_LABEL}</Text>
                  </View>
                  {!!vouched && <Text style={styles.heroVouchText}>{vouched}</Text>}
                </View>
              )}
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
  // Purple is the Seeker-specific family (Seed Vault, Works on Seeker chips).
  heroOwners: { borderColor: colors.purple },
  heroMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  heroMetaText: {
    color: colors.textDim, fontSize: 11, fontVariant: ['tabular-nums'], flexShrink: 1,
  },
  // Wraps: on a narrow phone the count line moves under the chip instead of
  // being cut off or pushing the chip out of the card.
  heroVouch: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center',
    columnGap: 8, rowGap: 4, marginTop: 6,
  },
  heroVouchText: {
    color: colors.textDim, fontSize: 11, fontVariant: ['tabular-nums'], flexShrink: 1,
  },
  // AppCard's badge recipe.
  badge: {
    borderWidth: 1, borderColor: colors.purple, borderRadius: 8,
    paddingHorizontal: 5, paddingVertical: 1,
  },
  badgeText: { color: colors.purple, fontSize: 9, fontWeight: '700' },
  rail: { paddingHorizontal: 16, gap: 10, paddingBottom: 4 },
  tile: {
    width: 96, backgroundColor: colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: colors.border,
    padding: 10, alignItems: 'center', gap: 6,
  },
  tileName: { color: colors.text, fontSize: 11, fontWeight: '600', textAlign: 'center' },
});
