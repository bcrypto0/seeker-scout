import React from 'react';
import { StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { colors } from '../theme';

/**
 * App icon with disk cache and a flat placeholder. No blurhash/transition —
 * both misbehave in recycled list rows (battle plan §6.9).
 */
export function AppIcon({ uri, size = 44 }: { uri?: string; size?: number }) {
  return (
    <Image
      source={uri ? { uri } : undefined}
      recyclingKey={uri}
      cachePolicy="memory-disk"
      contentFit="cover"
      style={[
        styles.icon,
        { width: size, height: size, borderRadius: size >= 64 ? 16 : 12 },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  icon: {
    backgroundColor: '#1E1E24',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
});
