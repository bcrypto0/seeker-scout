import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { AppIcon } from '../components/AppIcon';
import { PressableCard } from '../components/PressableCard';
import {
  fetchCatalog,
  fetchPerks,
  fetchRewards,
  isCatalogCached,
  onLiveCatalog,
} from '../lib/catalog';
import { AppPerk, DappEntry, RewardEntry } from '../lib/types';
import { colors, fonts, heading } from '../theme';

/** Display labels for detected perk kinds (indexer emits the keys). */
const KIND_LABELS: Record<string, string> = {
  airdrop: 'Airdrop',
  'play-to-earn': 'Play-to-earn',
  staking: 'Staking',
  earn: 'Earn',
  cashback: 'Cashback',
  rewards: 'Rewards',
  points: 'Points',
  mining: 'Mining',
};

const PAGE = 25;

/**
 * Rewards v2 (battle plan §3): structured, status-aware, deep-linked — "the
 * only rewards feed that tells you what's still claimable." Fed by hosted
 * rewards.json (remote config; new rewards ship with no app release).
 * v0.4 adds the auto-detected "all apps with rewards" section (perks.json)
 * — pulamea.skr's review ask.
 */
export function RewardsScreen() {
  const [rewards, setRewards] = useState<RewardEntry[]>([]);
  const [showPast, setShowPast] = useState(false);
  const [perks, setPerks] = useState<AppPerk[]>([]);
  const [kind, setKind] = useState<string>('all');
  const [visible, setVisible] = useState(PAGE);
  // Catalog join map, prefetched so perk taps are instant + synchronous
  // (no await on the tap path — see PerkCard).
  const [byId, setById] = useState<Map<string, DappEntry>>(new Map());

  const showCatalog = useCallback((list: DappEntry[]) => {
    setById(new Map(list.map((a) => [a.id, a] as const)));
  }, []);
  const loadCatalog = useCallback(() => {
    fetchCatalog().then(showCatalog);
  }, [showCatalog]);

  useEffect(() => {
    fetchRewards().then(setRewards);
    loadCatalog();
  }, [loadCatalog]);

  // A live catalog that lands after the offline seed (slow link, background retry).
  useEffect(() => onLiveCatalog(showCatalog), [showCatalog]);

  // Perks are the headline feature — a failed fetch must not hide it for
  // the whole session. Retry on every tab focus until we have data (and
  // retry the catalog join too if only the seed fallback landed).
  useFocusEffect(
    useCallback(() => {
      if (perks.length === 0) {
        fetchPerks().then((p) => p.length > 0 && setPerks(p));
      }
      if (!isCatalogCached()) loadCatalog();
    }, [perks.length, loadCatalog]),
  );

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

  // Kind filter chips: only kinds that actually occur, ordered by count.
  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of perks) for (const k of p.kinds) counts[k] = (counts[k] ?? 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [perks]);

  const filtered = useMemo(
    () => (kind === 'all' ? perks : perks.filter((p) => p.kinds.includes(kind as never))),
    [perks, kind],
  );

  const pickKind = (k: string) => {
    Haptics.selectionAsync().catch(() => {});
    setKind(k);
    setVisible(PAGE); // reset paging when the filter changes
  };

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 24 }}
        removeClippedSubviews
      >
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

        {perks.length > 0 && (
          <>
            <Text style={styles.section}>
              ALL APPS WITH REWARDS ({perks.length})
            </Text>
            <Text style={styles.perksSub}>
              Auto-detected from every dApp Store listing — updated daily.
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
            >
              <Chip
                label={`All ${perks.length}`}
                active={kind === 'all'}
                onPress={() => pickKind('all')}
              />
              {kindCounts.map(([k, n]) => (
                <Chip
                  key={k}
                  label={`${KIND_LABELS[k] ?? k} ${n}`}
                  active={kind === k}
                  onPress={() => pickKind(k)}
                />
              ))}
            </ScrollView>
            {filtered.slice(0, visible).map((p) => (
              <PerkCard key={p.id} p={p} app={byId.get(p.id)} />
            ))}
            {filtered.length > visible && (
              <Pressable
                style={styles.more}
                onPress={() => setVisible((v) => v + 50)}
              >
                <Text style={styles.moreText}>
                  Show more ({filtered.length - visible} left)
                </Text>
              </Pressable>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/** Filter chip — Discover's device-proven recipe (fixed height, centered). */
const Chip = React.memo(function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8 }}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
});

/**
 * Auto-detected perk row. Tap is SYNCHRONOUS — the catalog entry was
 * prefetched into the join map, so it either opens the in-app detail page
 * instantly or deep-links to the store listing instantly. Never awaits on
 * the tap path (an awaited ~1MB fetch here stalled taps up to 8s).
 * Memoized: PAST-toggle / chip changes must not reconcile every card.
 */
const PerkCard = React.memo(function PerkCard({
  p,
  app,
}: {
  p: AppPerk;
  app?: DappEntry;
}) {
  const nav = useNavigation<any>();
  const open = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (app) nav.navigate('AppDetail', { app });
    else Linking.openURL(`solanadappstore://details?id=${p.id}`).catch(() => {});
  };

  return (
    <PressableCard style={styles.perkCard} onPress={open}>
      <View style={styles.cardRow}>
        <AppIcon uri={p.iconUrl} size={36} />
        <View style={{ flex: 1, marginLeft: 10 }}>
          <View style={styles.titleRow}>
            <Text style={styles.perkName} numberOfLines={1}>
              {p.name}
            </Text>
            <Text style={styles.perkKinds} numberOfLines={1}>
              {p.kinds.map((k) => KIND_LABELS[k] ?? k).join(' · ')}
            </Text>
          </View>
          {!!p.snippet && (
            <Text style={styles.perkSnippet} numberOfLines={2}>
              {p.snippet}
            </Text>
          )}
        </View>
      </View>
    </PressableCard>
  );
});

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
  perksSub: {
    color: colors.textDim, fontSize: 12,
    paddingHorizontal: 16, marginTop: -4, marginBottom: 10,
  },
  chipRow: { paddingHorizontal: 16, gap: 8, paddingBottom: 12 },
  chip: {
    height: 34, paddingHorizontal: 14, borderRadius: 17,
    borderWidth: 1, borderColor: colors.border,
    justifyContent: 'center', backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.green, borderColor: colors.green },
  chipText: {
    color: colors.textDim, fontSize: 13, fontWeight: '700',
    includeFontPadding: false,
  },
  chipTextActive: { color: '#00140B' },
  perkCard: {
    backgroundColor: colors.card, borderRadius: 14, padding: 12,
    marginHorizontal: 16, marginBottom: 8,
    borderWidth: 1, borderColor: colors.border,
  },
  perkName: {
    color: colors.text, fontSize: 14, fontFamily: fonts.semi,
    flexShrink: 1,
  },
  perkKinds: {
    color: colors.green, fontSize: 10, fontWeight: '800',
    letterSpacing: 0.4, marginLeft: 8, flexShrink: 0, maxWidth: 150,
  },
  perkSnippet: { color: colors.textDim, fontSize: 12, marginTop: 3, lineHeight: 17 },
  more: {
    marginHorizontal: 16, marginTop: 4, height: 44, borderRadius: 12,
    borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  moreText: { color: colors.green, fontSize: 13, fontWeight: '700' },
});
