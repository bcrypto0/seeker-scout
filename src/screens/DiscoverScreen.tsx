import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AdBanner } from '../components/AdBanner';
import { AppCard } from '../components/AppCard';
import { fetchCatalog } from '../lib/catalog';
import { Category, DappEntry } from '../lib/types';
import { colors } from '../theme';

const CATEGORIES: (Category | 'All')[] = [
  'All', 'DeFi & Trading', 'Games', 'Wallets', 'DePIN', 'NFTs',
  'Privacy & Security', 'Content & Streaming', 'Productivity',
  'Social & Identity', 'AI & Agents', 'Lifestyle',
];

type SortMode = 'trending' | 'newest';

const SORTS: { key: SortMode; label: string }[] = [
  { key: 'trending', label: '🔥 Trending' },
  { key: 'newest', label: '🆕 Newest' },
];

/**
 * "Newest" = most recent activity: first store listing (firstSeen) or latest
 * release (lastUpdated), whichever is later — so newly-listed apps carrying
 * the NEW badge rank by the same date the badge is derived from.
 */
const newestKey = (a: DappEntry) =>
  (a.firstSeen && a.firstSeen > a.lastUpdated ? a.firstSeen : a.lastUpdated) ||
  '';

export function DiscoverScreen() {
  const [apps, setApps] = useState<DappEntry[]>([]);
  const [cat, setCat] = useState<Category | 'All'>('All');
  const [sort, setSort] = useState<SortMode>('trending');
  const listRef = useRef<FlatList<DappEntry>>(null);

  useEffect(() => {
    fetchCatalog().then(setApps);
  }, []);

  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [sort, cat]);

  const filtered = useMemo(
    () =>
      apps
        .filter((a) => cat === 'All' || a.category === cat)
        .sort((a, b) =>
          sort === 'newest'
            ? newestKey(b).localeCompare(newestKey(a)) ||
              b.trendScore - a.trendScore
            : b.trendScore - a.trendScore,
        ),
    [apps, cat, sort],
  );

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Text style={styles.h1}>Discover</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chips}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
      >
        {CATEGORIES.map((c) => (
          <Pressable
            key={c}
            onPress={() => setCat(c)}
            hitSlop={{ top: 8, bottom: 8 }}
            style={[styles.chip, cat === c && styles.chipActive]}
          >
            <Text style={[styles.chipText, cat === c && styles.chipTextActive]}>
              {c}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.sortRow}>
        {SORTS.map((s) => (
          <Pressable
            key={s.key}
            onPress={() => setSort(s.key)}
            hitSlop={{ top: 8, bottom: 8 }}
            style={[styles.chip, sort === s.key && styles.chipActive]}
          >
            <Text
              style={[styles.chipText, sort === s.key && styles.chipTextActive]}
            >
              {s.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <FlatList
        ref={listRef}
        data={filtered}
        keyExtractor={(a) => a.id}
        ListHeaderComponent={<AdBanner />}
        renderItem={({ item }) => <AppCard app={item} />}
        contentContainerStyle={{ paddingBottom: 24 }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingTop: 8 },
  h1: {
    color: colors.text, fontSize: 28, fontWeight: '800',
    paddingHorizontal: 16, marginBottom: 8,
  },
  chips: { flexGrow: 0, marginBottom: 8 },
  sortRow: {
    flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 12,
  },
  chip: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 999,
    paddingHorizontal: 12, paddingVertical: 7,
  },
  chipActive: { backgroundColor: colors.green, borderColor: colors.green },
  // Explicit lineHeight: Android clips descenders (g, y) without it.
  chipText: { color: colors.textDim, fontSize: 13, lineHeight: 17 },
  chipTextActive: { color: '#00140B', fontWeight: '700' },
});
