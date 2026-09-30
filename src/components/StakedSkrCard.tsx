import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { STAKE_EXPLAINER, STAKE_SHARED_NOTE, stakeCardView } from '../lib/skr';
import type { StakeState } from '../lib/useStakeRead';
import { colors, fonts } from '../theme';
import { SkeletonLines } from './Skeleton';

/**
 * STAKED SKR on the Profile (SPEC-skr-final 3, read only): the connected
 * wallet's staked SKR, any SKR in an unstake cooldown with when it becomes
 * withdrawable, and the vouch weight the stake gives, all from one public
 * chain read (skrRead.ts). Mounted only while a wallet is connected. A read
 * that fails any check shows one sentence and a Retry, never a number.
 * No stake buttons: staking from the app is a later, separate step.
 */
export function StakedSkrCard({
  state,
  busy,
  noGenesis,
  onRefresh,
}: {
  state: StakeState;
  busy: boolean;
  /** The Genesis check found no Genesis Token in this wallet. */
  noGenesis: boolean;
  onRefresh: () => void;
}) {
  const read = state.kind === 'done' ? state.read : null;
  const [now, setNow] = useState(() => Date.now());

  // The countdown is local arithmetic on the chain's timestamps: one re-render a minute, no read.
  const until = read?.withdrawableAt ?? null;
  useEffect(() => {
    setNow(Date.now());
    if (until === null || until * 1000 <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [read, until]);

  const view = read ? stakeCardView(read, { noGenesis, nowMs: now }) : null;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.label}>STAKED SKR</Text>
        {view?.ok &&
          (busy ? (
            <ActivityIndicator size="small" color={colors.textDim} />
          ) : (
            <Pressable onPress={onRefresh} hitSlop={10} accessibilityRole="button">
              <Text style={styles.link}>Refresh</Text>
            </Pressable>
          ))}
      </View>

      {!view && (
        <View style={styles.skeleton}>
          <SkeletonLines widths={['45%', '70%']} />
        </View>
      )}

      {view && !view.ok && (
        <>
          <Text style={styles.warn}>{view.error}</Text>
          <Pressable
            style={[styles.ghost, busy && styles.dimmed]}
            onPress={onRefresh}
            disabled={busy}
            accessibilityRole="button"
          >
            {busy ? (
              <ActivityIndicator size="small" color={colors.textDim} />
            ) : (
              <Text style={styles.ghostText}>Retry</Text>
            )}
          </Pressable>
        </>
      )}

      {view?.ok && (
        <>
          <Text style={styles.amount}>{view.amount}</Text>
          {!!view.weight && <Text style={styles.weight}>{view.weight}</Text>}
          {!!view.weightNote && <Text style={styles.warn}>{view.weightNote}</Text>}
          {!!view.unstaking && (
            <View style={styles.cooldown}>
              <Text style={styles.body}>{view.unstaking}</Text>
              {!!view.cooldown && <Text style={styles.dim}>{view.cooldown}</Text>}
            </View>
          )}
          <Text style={styles.dim}>{STAKE_EXPLAINER}</Text>
          <Text style={styles.dim}>{STAKE_SHARED_NOTE}</Text>
          <Text style={styles.fine}>{view.source}</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // ProfileScreen's card, label and warn recipes; VouchCard's ghost button and link.
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 20,
  },
  label: {
    color: colors.green,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  link: { color: colors.green, fontSize: 12, fontWeight: '800' },
  skeleton: { marginTop: 12 },
  amount: {
    color: colors.text,
    fontSize: 24,
    fontFamily: fonts.heavy,
    fontVariant: ['tabular-nums'],
    marginTop: 6,
  },
  weight: { color: colors.green, fontSize: 14, fontWeight: '700', marginTop: 4 },
  cooldown: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  body: { color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'] },
  dim: { color: colors.textDim, fontSize: 12, lineHeight: 17, marginTop: 8 },
  fine: { color: colors.textDim, fontSize: 11, lineHeight: 15, marginTop: 10, opacity: 0.8 },
  warn: { color: colors.yellow, marginTop: 12, fontSize: 13 },
  ghost: {
    marginTop: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    minHeight: 40,
    justifyContent: 'center',
  },
  ghostText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  dimmed: { opacity: 0.6 },
});
