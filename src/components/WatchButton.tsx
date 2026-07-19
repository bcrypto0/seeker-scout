import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import * as Haptics from 'expo-haptics';
import { isWatched, toggleWatch } from '../lib/watchlist';
import { colors } from '../theme';

/** Star toggle to add/remove an app from the local watchlist. */
export function WatchButton({ id, size = 22 }: { id: string; size?: number }) {
  const [on, setOn] = useState(false);

  useEffect(() => {
    let alive = true;
    isWatched(id).then((v) => alive && setOn(v));
    return () => {
      alive = false;
    };
  }, [id]);

  const toggle = async () => {
    Haptics.selectionAsync().catch(() => {});
    setOn(await toggleWatch(id));
  };

  return (
    <Pressable
      onPress={toggle}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
    >
      <Text
        style={[styles.star, { fontSize: size, color: on ? colors.yellow : colors.textDim }]}
      >
        {on ? '★' : '☆'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  star: { fontWeight: '900' },
});
