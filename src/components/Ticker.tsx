import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';

const GAP = 48;
const SPEED_DP_PER_SEC = 40;

/**
 * Auto-scrolling marquee of ecosystem pulse ("Raydium ▲12 · 14 new this
 * week…"). Unlike SolanaFloor's generic BTC ticker, this shows the Seeker
 * store's own movement (battle plan §4.6). Plain Animated loop, two text
 * copies for a seamless wrap; content narrower than the viewport renders
 * static (the two-copy trick only wraps cleanly when text overflows).
 */
export function Ticker({ items }: { items: string[] }) {
  const x = useRef(new Animated.Value(0)).current;
  const [textWidth, setTextWidth] = useState(0);
  const [clipWidth, setClipWidth] = useState(0);
  const text = items.join('    ·    ');
  const scrolls = textWidth > 0 && clipWidth > 0 && textWidth > clipWidth;

  useEffect(() => {
    if (!scrolls) {
      x.setValue(0);
      return;
    }
    x.setValue(0);
    const distance = textWidth + GAP;
    const anim = Animated.loop(
      Animated.timing(x, {
        toValue: -distance,
        duration: (distance / SPEED_DP_PER_SEC) * 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    anim.start();
    return () => anim.stop();
  }, [scrolls, textWidth, text, x]);

  if (!items.length) return null;

  return (
    <View
      style={styles.clip}
      onLayout={(e) => setClipWidth(e.nativeEvent.layout.width)}
    >
      <Animated.View
        style={{ flexDirection: 'row', transform: [{ translateX: x }] }}
      >
        <Text
          style={styles.text}
          numberOfLines={1}
          onLayout={(e) => setTextWidth(e.nativeEvent.layout.width)}
        >
          {text}
        </Text>
        {scrolls && (
          <>
            <View style={{ width: GAP }} />
            <Text style={styles.text} numberOfLines={1}>
              {text}
            </Text>
          </>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {
    overflow: 'hidden',
    marginBottom: 10,
    paddingVertical: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  text: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
