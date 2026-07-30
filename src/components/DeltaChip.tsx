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
  const size = Math.abs(delta);
  // Two digits keep the chip from stretching the card, but a bare "99" reads
  // as a VALUE — which is how four unrelated apps once all displayed "▲99"
  // and hid a real ranking bug for days (2026-07-29). Mark the clamp.
  return (
    <Text style={[styles.chip, { color: up ? colors.green : colors.red }]}>
      {up ? '▲' : '▼'}
      {size > 99 ? '99+' : size}
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
