import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppCard } from '../components/AppCard';
import { SkeletonList } from '../components/Skeleton';
import { fetchCatalog, isCatalogCached } from '../lib/catalog';
import { catOf } from '../lib/collections';
import { DappEntry } from '../lib/types';
import { colors, heading } from '../theme';

export function SearchScreen() {
  const [apps, setApps] = useState<DappEntry[]>([]);
  const [loading, setLoading] = useState(() => !isCatalogCached());
  const [q, setQ] = useState('');

  useEffect(() => {
    fetchCatalog().then((a) => {
      setApps(a);
      setLoading(false);
    });
  }, []);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return apps;
    return apps.filter(
      (a) =>
        a.name.toLowerCase().includes(needle) ||
        (a.description ?? '').toLowerCase().includes(needle) ||
        // Both names: the store's current category AND the pre-September
        // one, so "defi" still finds apps now filed under "Earn & DeFi".
        catOf(a).toLowerCase().includes(needle) ||
        a.category.toLowerCase().includes(needle),
    );
  }, [apps, q]);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Text style={styles.h1}>Search</Text>
      <TextInput
        style={styles.input}
        placeholder="App name, category, keyword…"
        placeholderTextColor={colors.textDim}
        value={q}
        onChangeText={setQ}
      />
      {loading ? (
        <SkeletonList />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(a) => a.id}
          renderItem={({ item }) => <AppCard app={item} />}
          contentContainerStyle={{ paddingBottom: 24 }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingTop: 8 },
  h1: { ...heading, paddingHorizontal: 16, marginBottom: 8 },
  input: {
    backgroundColor: colors.card, color: colors.text,
    borderWidth: 1, borderColor: colors.border, borderRadius: 12,
    marginHorizontal: 16, marginBottom: 12,
    paddingHorizontal: 14, paddingVertical: 10, fontSize: 15,
  },
});
