import React, { useRef } from 'react';
import {
  Animated,
  Pressable,
  StyleProp,
  ViewStyle,
} from 'react-native';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Pressable with a 0.96 scale-down — the physical response that makes the
 * app feel native (battle plan §4.5). Style goes on the Pressable itself so
 * outer margins stay OUTSIDE the hit box, and cards without an onPress don't
 * animate (no fake tappability).
 */
export function PressableCard({
  children,
  style,
  onPress,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number) =>
    Animated.spring(scale, {
      toValue: v,
      speed: 40,
      bounciness: 0,
      useNativeDriver: true,
    }).start();

  return (
    <AnimatedPressable
      onPress={onPress}
      disabled={!onPress}
      onPressIn={onPress ? () => to(0.96) : undefined}
      onPressOut={onPress ? () => to(1) : undefined}
      style={[style, { transform: [{ scale }] }]}
    >
      {children}
    </AnimatedPressable>
  );
}
