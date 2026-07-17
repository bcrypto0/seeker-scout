import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { colors } from '../theme';

/**
 * Rank movement vs yesterday: ▲3 climbed / ▼2 fell. Renders nothing for
 * no-change or no-data — movement should read as signal, not noise.
 */
export function DeltaChip({ delta }: { delta?: number }) {
  if (!delta) return null;
  const up = delta > 0;
  return (
    <Text style={[styles.chip, { color: up ? colors.green : colors.red }]}>
      {up ? '▲' : '▼'}
      {Math.min(Math.abs(delta), 99)}
    </Text>
  );
}

const styles = StyleSheet.create({
  chip: {
    fontSize: 11,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
});
