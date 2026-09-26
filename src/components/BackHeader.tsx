import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { colors, heading } from '../theme';

/** Back arrow + title + optional right slot, matching the chat screen's bar. */
export function BackHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  const nav = useNavigation();
  return (
    <View style={styles.bar}>
      <Pressable onPress={() => nav.goBack()} hitSlop={12} accessibilityLabel="Back">
        <Text style={styles.back}>←</Text>
      </Pressable>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.right}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10, gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  back: { color: colors.text, fontSize: 24, fontWeight: '700', width: 24 },
  title: { ...heading, fontSize: 20, flex: 1, textAlign: 'center' },
  right: { minWidth: 24, alignItems: 'flex-end' },
});
