import React, { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppCard } from '../components/AppCard';
import { fetchCatalog } from '../lib/catalog';
import { Category, DappEntry } from '../lib/types';
import { colors } from '../theme';

const CATEGORIES: (Category | 'All')[] = [
  'All', 'DeFi & Trading', 'Games', 'Wallets', 'DePIN', 'NFTs',
  'Privacy & Security', 'Content & Streaming', 'Productivity',
  'Social & Identity', 'AI & Agents', 'Lifestyle',
];

export function DiscoverScreen() {
  const [apps, setApps] = useState<DappEntry[]>([]);
  const [cat, setCat] = useState<Category | 'All'>('All');

  useEffect(() => {
    fetchCatalog().then(setApps);
  }, []);

  const filtered = useMemo(
    () =>
      apps
        .filter((a) => cat === 'All' || a.category === cat)
        .sort((a, b) => b.trendScore - a.trendScore),
    [apps, cat],
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
            style={[styles.chip, cat === c && styles.chipActive]}
          >
            <Text style={[styles.chipText, cat === c && styles.chipTextActive]}>
              {c}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <FlatList
        data={filtered}
        keyExtractor={(a) => a.id}
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
  chips: { flexGrow: 0, marginBottom: 12 },
  chip: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 999,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  chipActive: { backgroundColor: colors.green, borderColor: colors.green },
  chipText: { color: colors.textDim, fontSize: 13 },
  chipTextActive: { color: '#00140B', fontWeight: '700' },
});
