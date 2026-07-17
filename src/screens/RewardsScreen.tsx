import React, { useEffect, useMemo, useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { AppIcon } from '../components/AppIcon';
import { PressableCard } from '../components/PressableCard';
import { fetchRewards } from '../lib/catalog';
import { RewardEntry } from '../lib/types';
import { colors, fonts, heading } from '../theme';

/**
 * Rewards v2 (battle plan §3): structured, status-aware, deep-linked — "the
 * only rewards feed that tells you what's still claimable." Fed by hosted
 * rewards.json (remote config; new rewards ship with no app release).
 */
export function RewardsScreen() {
  const [rewards, setRewards] = useState<RewardEntry[]>([]);
  const [showPast, setShowPast] = useState(false);

  useEffect(() => {
    fetchRewards().then(setRewards);
  }, []);

  // Local-midnight day boundary: an offer stays ACTIVE through the whole of
  // its endsAt day in the user's timezone (not UTC).
  const today = localDay();
  const { season, active, past } = useMemo(() => {
    const isPast = (r: RewardEntry) => !!r.endsAt && r.endsAt < today;
    return {
      season: rewards.filter((r) => r.kind === 'season' && !isPast(r)),
      active: rewards.filter((r) => r.kind !== 'season' && !isPast(r)),
      past: rewards.filter(isPast),
    };
  }, [rewards, today]);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <Text style={styles.h1}>Rewards</Text>
        <Text style={styles.sub}>
          Verified perks and SKR season progress for Seeker owners.
        </Text>

        {season.map((r) => (
          <RewardCard key={r.id} r={r} pinned />
        ))}

        {active.length > 0 && <Text style={styles.section}>PARTNER PERKS</Text>}
        {active.map((r) => (
          <RewardCard key={r.id} r={r} />
        ))}

        {past.length > 0 && (
          <>
            <Pressable
              onPress={() => setShowPast((v) => !v)}
              hitSlop={{ top: 12, bottom: 12, left: 16, right: 16 }}
              style={({ pressed }) => pressed && { opacity: 0.6 }}
            >
              <Text style={styles.section}>
                PAST ({past.length}) {showPast ? '▾' : '▸'}
              </Text>
            </Pressable>
            {showPast && past.map((r) => <RewardCard key={r.id} r={r} expired />)}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/** YYYY-MM-DD in the device's local timezone. */
function localDay(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Whole days until the END of the endsAt day, local time — consistent with
 * the isPast boundary (a reward is claimable through its entire final day).
 * 0 = ends today.
 */
function daysLeft(endsAt?: string): number | undefined {
  if (!endsAt) return undefined;
  // No 'Z' suffix → parsed as LOCAL midnight; add a day for end-of-day.
  const endOfDay = new Date(`${endsAt}T00:00:00`).getTime() + 86_400_000;
  const ms = endOfDay - Date.now();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

function RewardCard({
  r,
  pinned,
  expired,
}: {
  r: RewardEntry;
  pinned?: boolean;
  expired?: boolean;
}) {
  const left = daysLeft(r.endsAt);
  const open = (url: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    Linking.openURL(url).catch(() => {});
  };

  return (
    <PressableCard
      style={[
        styles.card,
        pinned && { borderColor: colors.green },
        expired && { opacity: 0.55 },
      ]}
    >
      <View style={styles.cardRow}>
        {!!r.iconUrl && <AppIcon uri={r.iconUrl} size={36} />}
        <View style={{ flex: 1, marginLeft: r.iconUrl ? 10 : 0 }}>
          <View style={styles.titleRow}>
            <Text style={styles.app}>{r.app.toUpperCase()}</Text>
            {expired ? (
              <Text style={[styles.status, { color: colors.textDim }]}>PAST</Text>
            ) : left !== undefined && left <= 7 ? (
              <Text style={[styles.status, { color: colors.yellow }]}>
                {left === 0 ? 'ENDS TODAY' : `ENDS IN ${left}D`}
              </Text>
            ) : (
              <Text style={[styles.status, { color: colors.green }]}>ACTIVE</Text>
            )}
          </View>
          <Text style={styles.title}>{r.title}</Text>
        </View>
      </View>
      <Text style={styles.detail}>{r.detail}</Text>
      <View style={styles.actions}>
        {!!r.url && (
          <Pressable style={styles.btnGhost} onPress={() => open(r.url!)}>
            <Text style={styles.btnGhostText}>Details</Text>
          </Pressable>
        )}
        {!!r.packageId && (
          <Pressable
            style={styles.btnSolid}
            onPress={() => open(`solanadappstore://details?id=${r.packageId}`)}
          >
            <Text style={styles.btnSolidText}>Get app</Text>
          </Pressable>
        )}
      </View>
      {!!r.verified && !expired && (
        <Text style={styles.verified}>verified {r.verified}</Text>
      )}
    </PressableCard>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingTop: 8 },
  h1: { ...heading, paddingHorizontal: 16 },
  sub: {
    color: colors.textDim, fontSize: 13,
    paddingHorizontal: 16, marginBottom: 12, marginTop: 2,
  },
  section: {
    color: colors.textDim, fontSize: 11, fontWeight: '800',
    letterSpacing: 1, paddingHorizontal: 16, marginTop: 14, marginBottom: 8,
  },
  card: {
    backgroundColor: colors.card, borderRadius: 14, padding: 14,
    marginHorizontal: 16, marginBottom: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  cardRow: { flexDirection: 'row', alignItems: 'center' },
  titleRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: 8,
  },
  app: { color: colors.green, fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  status: { fontSize: 10, fontWeight: '800', fontVariant: ['tabular-nums'] },
  title: { color: colors.text, fontSize: 15, fontFamily: fonts.semi, marginTop: 2 },
  detail: { color: colors.textDim, fontSize: 13, marginTop: 8, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  btnGhost: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 8, minHeight: 36,
    alignItems: 'center', justifyContent: 'center',
  },
  btnGhostText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  btnSolid: {
    backgroundColor: colors.green, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 8, minHeight: 36,
    alignItems: 'center', justifyContent: 'center',
  },
  btnSolidText: { color: '#00140B', fontSize: 12, fontWeight: '800' },
  verified: { color: colors.textDim, fontSize: 10, marginTop: 10 },
});
