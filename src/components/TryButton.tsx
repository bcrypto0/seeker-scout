import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import * as Haptics from 'expo-haptics';
import { isOnTryList, toggleTry } from '../lib/trylist';
import { colors } from '../theme';

/**
 * "Try later" pill (v0.7, redacted.skr's review ask). Lives on the detail
 * page rather than the cards: pinning is a considered action taken after
 * reading about an app, and a second icon on every card row is clutter.
 */
export function TryButton({ id }: { id: string }) {
  const [on, setOn] = useState(false);

  useEffect(() => {
    let alive = true;
    isOnTryList(id).then((v) => alive && setOn(v));
    return () => {
      alive = false;
    };
  }, [id]);

  const toggle = async () => {
    Haptics.selectionAsync().catch(() => {});
    setOn(await toggleTry(id));
  };

  return (
    <Pressable
      onPress={toggle}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={[styles.pill, on && styles.pillOn]}
    >
      <Text style={[styles.text, on && styles.textOn]}>
        {on ? '✓ On your try list' : '📌 Try later'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    height: 34,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignSelf: 'flex-start',
  },
  pillOn: { borderColor: colors.green, backgroundColor: 'rgba(20,241,149,0.08)' },
  text: { color: colors.textDim, fontSize: 13, fontWeight: '700', includeFontPadding: false },
  textOn: { color: colors.green },
});
