import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { requestNotifPermission } from '../lib/notify';
import { maybeAskAfterFirstStar } from '../lib/reviewPrompt';
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
    const nowOn = await toggleWatch(id);
    setOn(nowOn);
    if (!nowOn) return;

    // Ask for notifications HERE, not on cold start. Starring is the moment
    // the permission makes sense ("tell me when this app moves"), so the
    // dialog is answerable instead of arriving before the user has done
    // anything — which is the classic route to a permanent deny.
    //
    // Gate on PERMISSION STATE, not watchlist length: existing users who
    // already have stars would never hit length===1 again, so they'd be
    // permanently unable to grant and their alerts would silently never fire.
    // getPermissionsAsync shows no UI, so this is free when already granted.
    let asked = false;
    try {
      const perm = await Notifications.getPermissionsAsync();
      if (perm.status !== 'granted' && perm.canAskAgain) {
        await requestNotifPermission();
        asked = true;
      }
    } catch {
      /* permission probing is best-effort */
    }
    // Never stack dialogs — if the OS prompt just appeared, leave the review
    // ask for another day rather than burning our single lifetime prompt on
    // top of it.
    if (!asked) await maybeAskAfterFirstStar();
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
