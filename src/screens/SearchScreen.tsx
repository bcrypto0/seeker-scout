import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppCard } from '../components/AppCard';
import { SkeletonList } from '../components/Skeleton';
import { fetchCatalog, isCatalogCached, onLiveCatalog } from '../lib/catalog';
import { catOf } from '../lib/collections';
import { getNotForMe, onNotForMeChange } from '../lib/notForMe';
import { DappEntry } from '../lib/types';
import { colors, heading } from '../theme';

export function SearchScreen() {
  const [apps, setApps] = useState<DappEntry[]>([]);
  const [loading, setLoading] = useState(() => !isCatalogCached());
  const [q, setQ] = useState('');
  // Search skips nothing: an app on the Not for me list is found like any
  // other and carries the mark, since a search for it is deliberate.
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  useEffect(() => {
    const show = (a: DappEntry[]) => {
      setApps(a);
      setLoading(false);
    };
    fetchCatalog().then(show);
    // A live catalog that lands after the offline seed was shown replaces it.
    const offLive = onLiveCatalog(show);
    const readHidden = () => {
      getNotForMe().then((ids) => setHidden(new Set(ids)));
    };
    readHidden();
    const offHidden = onNotForMeChange(readHidden);
    return () => {
      offLive();
      offHidden();
    };
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
          // The mark on each row follows the list.
          extraData={hidden}
          keyExtractor={(a) => a.id}
          renderItem={({ item }) => <AppCard app={item} notForMe={hidden.has(item.id)} />}
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
