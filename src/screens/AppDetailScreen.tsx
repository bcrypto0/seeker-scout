import React, { useEffect, useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { AppIcon } from '../components/AppIcon';
import { DeltaChip } from '../components/DeltaChip';
import { Sparkline } from '../components/Sparkline';
import { WatchButton } from '../components/WatchButton';
import { fetchCatalog } from '../lib/catalog';
import { DappEntry } from '../lib/types';
import { colors, fonts, freshness } from '../theme';

const NEW_WINDOW_MS = 14 * 86_400_000;

/** In-app info page between the feed and the store (CEO request + move #9). */
export function AppDetailScreen() {
  const nav = useNavigation();
  const { app } = useRoute().params as { app: DappEntry };
  const [ranks, setRanks] = useState<{ overall?: number; cat?: number }>({});

  useEffect(() => {
    let alive = true;
    fetchCatalog().then((list) => {
      if (!alive) return;
      const sorted = [...list].sort((a, b) => b.trendScore - a.trendScore);
      const overall = sorted.findIndex((x) => x.id === app.id) + 1;
      // Rank within the LIVE entry's category (the route param may carry an
      // older category label than the current catalog).
      const liveCat = sorted.find((x) => x.id === app.id)?.category;
      const cat = liveCat
        ? sorted
            .filter((x) => x.category === liveCat)
            .findIndex((x) => x.id === app.id) + 1
        : 0;
      setRanks({ overall: overall || undefined, cat: cat || undefined });
    });
    return () => {
      alive = false;
    };
  }, [app.id]);

  const fresh = freshness(app.lastUpdated);
  const isNew =
    !!app.firstSeen && Date.now() - new Date(app.firstSeen).getTime() < NEW_WINDOW_MS;

  const openStore = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    Linking.openURL(`solanadappstore://details?id=${app.id}`).catch(() => {});
  };

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        <Pressable
          onPress={() => nav.goBack()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={styles.back}
        >
          <Text style={styles.backText}>← Back</Text>
        </Pressable>

        <View style={styles.header}>
          <AppIcon uri={app.iconUrl} size={72} />
          <View style={styles.headerBody}>
            <View style={styles.nameRow}>
              <Text style={styles.name} numberOfLines={1}>{app.name}</Text>
              <WatchButton id={app.id} size={26} />
            </View>
            {!!app.publisher && (
              <Text style={styles.publisher} numberOfLines={1}>
                {app.publisher.trim()}
              </Text>
            )}
            <View style={styles.badges}>
              <DeltaChip delta={app.rankDelta} />
              {isNew && (
                <View style={[styles.badge, { borderColor: colors.green }]}>
                  <Text style={[styles.badgeText, { color: colors.green }]}>NEW</Text>
                </View>
              )}
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
          </View>
        </View>

        <View style={styles.statsRow}>
          <Stat label="Rating" value={`★ ${app.rating.toFixed(1)}`} sub={`${app.reviews.toLocaleString()} reviews`} />
          <Stat label="Trend" value={`${app.trendScore}`} sub="scout score" />
          {!!ranks.overall && (
            <Stat
              label="Rank"
              value={`#${ranks.overall}`}
              sub={ranks.cat ? `#${ranks.cat} in ${app.category}` : 'overall'}
            />
          )}
        </View>

        {!!app.rankHistory && app.rankHistory.length >= 2 && (
          <View style={styles.trendCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.trendLabel}>7-DAY RANK</Text>
              <Text style={styles.trendSub}>
                {app.rankHistory[app.rankHistory.length - 1] <= app.rankHistory[0]
                  ? 'Climbing'
                  : 'Sliding'}
              </Text>
            </View>
            <Sparkline data={app.rankHistory} width={120} height={34} />
          </View>
        )}

        {!!(app.description || app.subtitle) && (
          <Text style={styles.description}>
            {app.description || app.subtitle}
          </Text>
        )}

        <InfoCard app={app} />

        <Pressable style={styles.storeBtn} onPress={openStore}>
          <Text style={styles.storeBtnText}>Get it on the dApp Store</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel} numberOfLines={1}>{label.toUpperCase()}</Text>
      <Text style={styles.statValue}>{value}</Text>
      {!!sub && <Text style={styles.statSub} numberOfLines={1}>{sub}</Text>}
    </View>
  );
}

function InfoCard({ app }: { app: DappEntry }) {
  const rows: { label: string; value: string; url?: string }[] = [
    { label: 'Category', value: String(app.category) },
    ...(app.version ? [{ label: 'Version', value: app.version }] : []),
    { label: 'Last updated', value: app.lastUpdated || '—' },
    ...(app.firstSeen
      ? [{ label: 'Listed on store', value: app.firstSeen }]
      : []),
    ...(app.onchainVerified
      ? [{
          label: 'On-chain',
          value: `⛓ Verified · ${app.onchainReleaseCount ?? 1} release${(app.onchainReleaseCount ?? 1) === 1 ? '' : 's'}`,
        }]
      : []),
    ...(app.website
      ? [{ label: 'Website', value: app.website, url: app.website }]
      : []),
  ];
  return (
    <View style={styles.infoCard}>
      {rows.map((r, i) => {
        const row = (
          <InfoRow
            key={r.label}
            label={r.label}
            value={r.value}
            link={!!r.url}
            last={i === rows.length - 1}
          />
        );
        return r.url ? (
          <Pressable
            key={r.label}
            onPress={() => Linking.openURL(r.url!).catch(() => {})}
          >
            {row}
          </Pressable>
        ) : (
          row
        );
      })}
    </View>
  );
}

function InfoRow({
  label,
  value,
  link,
  last,
}: {
  label: string;
  value: string;
  link?: boolean;
  last?: boolean;
}) {
  return (
    <View style={[styles.infoRow, last && { borderBottomWidth: 0 }]}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text
        style={[styles.infoValue, link && { color: colors.green }]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  back: { paddingHorizontal: 16, paddingVertical: 12 },
  backText: { color: colors.textDim, fontSize: 15, fontWeight: '600' },
  header: { flexDirection: 'row', paddingHorizontal: 16, alignItems: 'center' },
  headerBody: { flex: 1, marginLeft: 14 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { color: colors.text, fontSize: 22, fontFamily: fonts.heavy, flexShrink: 1 },
  trendCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.card, borderRadius: 14,
    borderWidth: 1, borderColor: colors.border,
    marginHorizontal: 16, marginTop: 18, padding: 14,
  },
  trendLabel: { color: colors.textDim, fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  trendSub: { color: colors.text, fontSize: 15, fontFamily: fonts.semi, marginTop: 3 },
  publisher: { color: colors.textDim, fontSize: 13, marginTop: 2 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  badge: {
    borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  badgeText: { fontSize: 10, fontWeight: '700' },
  statsRow: {
    flexDirection: 'row', gap: 10,
    paddingHorizontal: 16, marginTop: 18,
  },
  stat: {
    flex: 1, backgroundColor: colors.card, borderRadius: 14,
    borderWidth: 1, borderColor: colors.border, padding: 12,
  },
  statLabel: { color: colors.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.8 },
  statValue: {
    color: colors.text, fontSize: 18, fontFamily: fonts.heavy,
    marginTop: 4, fontVariant: ['tabular-nums'],
  },
  statSub: { color: colors.textDim, fontSize: 10, marginTop: 2 },
  description: {
    color: colors.textDim, fontSize: 14, lineHeight: 21,
    paddingHorizontal: 16, marginTop: 18,
  },
  infoCard: {
    backgroundColor: colors.card, borderRadius: 14,
    borderWidth: 1, borderColor: colors.border,
    marginHorizontal: 16, marginTop: 18, paddingHorizontal: 14,
  },
  infoRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: 12, gap: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  infoLabel: { color: colors.textDim, fontSize: 13 },
  infoValue: { color: colors.text, fontSize: 13, flexShrink: 1 },
  storeBtn: {
    backgroundColor: colors.green, borderRadius: 14,
    marginHorizontal: 16, marginTop: 22,
    paddingVertical: 15, alignItems: 'center', minHeight: 48,
  },
  storeBtnText: { color: '#00140B', fontSize: 15, fontWeight: '800' },
});
