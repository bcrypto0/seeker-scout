import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppCard } from '../components/AppCard';
import { fetchCatalog } from '../lib/catalog';
import { DappEntry } from '../lib/types';
import { colors } from '../theme';

export function SearchScreen() {
  const [apps, setApps] = useState<DappEntry[]>([]);
  const [q, setQ] = useState('');

  useEffect(() => {
    fetchCatalog().then(setApps);
  }, []);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return apps;
    return apps.filter(
      (a) =>
        a.name.toLowerCase().includes(needle) ||
        a.description.toLowerCase().includes(needle) ||
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
      <FlatList
        data={results}
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
  input: {
    backgroundColor: colors.card, color: colors.text,
    borderWidth: 1, borderColor: colors.border, borderRadius: 12,
    marginHorizontal: 16, marginBottom: 12,
    paddingHorizontal: 14, paddingVertical: 10, fontSize: 15,
  },
});
