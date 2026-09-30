import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import * as Haptics from 'expo-haptics';
import { isNotForMe, onNotForMeChange, toggleNotForMe } from '../lib/notForMe';
import { NOT_FOR_ME_LABEL } from '../lib/notForMeFilter';
import { colors } from '../theme';

/**
 * "Not for me" pill on the app page, beside Try later and Share: a founding
 * member's ask in the Lounge ("a simple red x to cross off dapps we've
 * already tried and didn't like"). On, the app leaves the Discover feed, Top
 * climbers and the hero picks; Search still finds it. It does not touch the
 * watchlist or the try list. The selected state is filled red, not only a
 * red outline, so it reads without relying on the color alone.
 */
export function NotForMeButton({ id, onChange }: { id: string; onChange?: (on: boolean) => void }) {
  const [on, setOn] = useState(false);
  // The latest callback, read when the list changes: not an effect input.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let alive = true;
    const read = () => {
      isNotForMe(id).then((v) => {
        if (!alive) return;
        setOn(v);
        onChangeRef.current?.(v);
      });
    };
    read();
    // An undo from Discover's Hidden list while this page is open keeps the pill true.
    const off = onNotForMeChange(read);
    return () => {
      alive = false;
      off();
    };
  }, [id]);

  const toggle = () => {
    Haptics.selectionAsync().catch(() => {});
    // The change listener above updates the pill once the list is saved.
    toggleNotForMe(id).catch(() => {});
  };

  return (
    <Pressable
      onPress={toggle}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={[styles.pill, on && styles.pillOn]}
      accessibilityRole="togglebutton"
      accessibilityLabel={NOT_FOR_ME_LABEL}
      accessibilityState={{ checked: on }}
      accessibilityHint={on ? 'Shows this app in Discover again' : 'Hides this app from the Discover feed'}
    >
      <Text style={[styles.text, on && styles.textOn]}>
        <Text style={on ? styles.textOn : styles.x}>✕</Text> {NOT_FOR_ME_LABEL}
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
  pillOn: { borderColor: colors.red, backgroundColor: colors.red },
  // Fixed line box: "✕" comes from a fallback font with taller metrics, the
  // way "★" did on the Discover chips (see chipText there).
  text: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 18,
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  textOn: { color: '#1A0505' },
  x: { color: colors.red },
});
