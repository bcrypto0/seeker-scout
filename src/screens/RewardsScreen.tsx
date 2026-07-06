import React from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SEED_REWARDS } from '../lib/catalog';
import { colors } from '../theme';

/**
 * Rewards tab: every active earn opportunity for Seeker owners in one place.
 * v0.2 adds a live feed + push notifications before claim deadlines.
 */
export function RewardsScreen() {
  return (
    <View style={styles.root}>
      <Text style={styles.h1}>Rewards</Text>
      <Text style={styles.sub}>
        Active boosts, airdrops, and deadlines for Seeker owners.
      </Text>
      <FlatList
        data={SEED_REWARDS}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.app}>{item.app}</Text>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.detail}>{item.detail}</Text>
            {item.deadline && (
              <Text style={styles.deadline}>Claim by {item.deadline}</Text>
            )}
          </View>
        )}
        contentContainerStyle={{ paddingBottom: 24 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingTop: 8 },
  h1: {
    color: colors.text, fontSize: 28, fontWeight: '800',
    paddingHorizontal: 16,
  },
  sub: {
    color: colors.textDim, fontSize: 13,
    paddingHorizontal: 16, marginBottom: 12,
  },
  card: {
    backgroundColor: colors.card, borderRadius: 14, padding: 14,
    marginHorizontal: 16, marginBottom: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  app: { color: colors.green, fontSize: 11, fontWeight: '700' },
  title: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 2 },
  detail: { color: colors.textDim, fontSize: 13, marginTop: 4 },
  deadline: { color: colors.yellow, fontSize: 12, marginTop: 6 },
});
