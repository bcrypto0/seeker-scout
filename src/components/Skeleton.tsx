import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { colors } from '../theme';

/**
 * Pulsing card-shaped placeholders while the catalog loads — perceived-speed
 * win over spinners (battle plan §4.4). Plain Animated opacity loop.
 */
export function SkeletonList({ rows = 6 }: { rows?: number }) {
  const pulse = usePulse();

  return (
    <View>
      {Array.from({ length: rows }, (_, i) => (
        <Animated.View key={i} style={[styles.card, { opacity: pulse }]}>
          <View style={styles.icon} />
          <View style={styles.body}>
            <View style={[styles.line, { width: '55%' }]} />
            <View style={[styles.line, { width: '85%', marginTop: 8 }]} />
            <View style={[styles.line, { width: '40%', marginTop: 8 }]} />
          </View>
        </Animated.View>
      ))}
    </View>
  );
}

/** The same pulsing lines for a card whose numbers are still loading (vouch card, top vouched). */
export function SkeletonLines({ widths = ['55%', '85%'] }: { widths?: `${number}%`[] }) {
  const pulse = usePulse();
  return (
    <Animated.View style={{ opacity: pulse }}>
      {widths.map((w, i) => (
        <View key={i} style={[styles.line, { width: w, marginTop: i ? 8 : 0 }]} />
      ))}
    </Animated.View>
  );
}

function usePulse() {
  const pulse = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.9, duration: 600, useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.35, duration: 600, useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return pulse;
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  icon: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: colors.cardNested,
  },
  body: { flex: 1, marginLeft: 12, justifyContent: 'center' },
  line: {
    height: 10, borderRadius: 5, backgroundColor: colors.cardNested,
  },
});
