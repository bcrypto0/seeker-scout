import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { AppCard } from '../components/AppCard';
import { DiscoverHeader } from '../components/DiscoverHeader';
import { SkeletonList } from '../components/Skeleton';
import { Ticker } from '../components/Ticker';
import { fetchCatalog, isCatalogCached, isSeedCatalog } from '../lib/catalog';
import {
  bayesRating,
  catOf,
  FRESH_STALE_DAYS,
  isAbandoned,
  isHighlyRated,
  RATING_HIGH,
} from '../lib/collections';
import { checkWatchlist } from '../lib/notify';
import { maybeAskAfterSessions } from '../lib/reviewPrompt';
import { getTryList, onTryListChange } from '../lib/trylist';
import { getWatchlist, onWatchlistChange } from '../lib/watchlist';
import { DappEntry } from '../lib/types';
import { colors, heading } from '../theme';

const WATCHING = '★ Watching';
const TO_TRY = '📌 To try';

/**
 * The chips that aren't store categories. Store categories themselves are
 * read from the catalog (see `chips` below), never hardcoded: in September
 * 2026 the dApp Store renamed and re-sorted all of them, and v0.9's
 * hardcoded list silently left 7 of 11 chips empty for every user.
 */
const FIXED_CHIPS = ['All', WATCHING, TO_TRY];

type SortMode = 'trending' | 'newest' | 'rated';

const SORTS: { key: SortMode; label: string }[] = [
  { key: 'trending', label: '🔥 Trending' },
  { key: 'newest', label: '🆕 Newest' },
  { key: 'rated', label: '⭐ Top rated' },
];

const newestKey = (a: DappEntry) =>
  (a.firstSeen && a.firstSeen > a.lastUpdated ? a.firstSeen : a.lastUpdated) ||
  '';

export function DiscoverScreen() {
  const [apps, setApps] = useState<DappEntry[]>([]);
  const [loading, setLoading] = useState(() => !isCatalogCached());
  const [refreshing, setRefreshing] = useState(false);
  const [cat, setCat] = useState<string>('All');
  const [sort, setSort] = useState<SortMode>('trending');
  // bacon.skr's ask, literal half: hide anything that isn't genuinely
  // well-rated (review-count gated so it can't fill up with 5.0-from-3 apps).
  const [topRatedOnly, setTopRatedOnly] = useState(false);
  // Hide apps that look ABANDONED: 6+ months without a release AND no recent
  // review activity AND no large installed base (isAbandoned). Opt-IN, not
  // the default: it removes ~13% of the store, and even the combined signal
  // is evidence of quiet, not proof of death — a finished single-purpose
  // tool can be quiet and fine. The user asks for it; we don't quietly
  // shrink the catalog for everyone.
  const [hideStale, setHideStale] = useState(false);
  const [watched, setWatched] = useState<Set<string>>(new Set());
  const [toTry, setToTry] = useState<Set<string>>(new Set());
  const listRef = useRef<FlatList<DappEntry>>(null);
  const checkedRef = useRef(false);

  useEffect(() => {
    fetchCatalog().then((a) => {
      setApps(a);
      setLoading(false);
      // One-time watchlist change check + local notifications per session.
      // NOTE: permission is NOT requested here — it's asked on the first ☆
      // tap, where the user has just expressed intent to track something.
      if (!checkedRef.current) {
        checkedRef.current = true;
        const ranked = [...a].sort((x, y) => y.trendScore - x.trendScore);
        checkWatchlist(ranked);
      }
    });
    getWatchlist().then((ids) => setWatched(new Set(ids)));
    // Let the feed settle before asking anything — a dialog on top of a
    // still-loading screen reads as an ad, not a request.
    const askTimer = setTimeout(() => {
      maybeAskAfterSessions();
    }, 2500);
    getTryList().then((ids) => setToTry(new Set(ids)));
    const off = onWatchlistChange(() =>
      getWatchlist().then((ids) => setWatched(new Set(ids))),
    );
    const offTry = onTryListChange(() =>
      getTryList().then((ids) => setToTry(new Set(ids))),
    );
    return () => {
      clearTimeout(askTimer);
      off();
      offTry();
    };
  }, []);

  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [sort, cat, topRatedOnly, hideStale]);

  const setSortHaptic = (s: SortMode) => {
    Haptics.selectionAsync().catch(() => {});
    setSort(s);
  };

  const onRefresh = () => {
    setRefreshing(true);
    fetchCatalog(true).then((a) => {
      setApps(a);
      setRefreshing(false);
    });
  };

  // Store categories straight from the catalog, biggest first.
  const chips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of apps) {
      const c = catOf(a);
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const cats = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([c]) => c);
    return [...FIXED_CHIPS, ...cats];
  }, [apps]);

  // A refresh can drop the category a user had selected (the store renames
  // them); don't strand them on an empty list with no chip to tap.
  useEffect(() => {
    if (apps.length && !chips.includes(cat)) setCat('All');
  }, [apps.length, chips, cat]);

  // Live catalog vs the build-frozen fallback we serve when the fetch fails.
  const offlineSeed = useMemo(() => isSeedCatalog(apps), [apps]);

  const filtered = useMemo(
    () =>
      apps
        .filter((a) =>
          cat === 'All'
            ? true
            : cat === WATCHING
              ? watched.has(a.id)
              : cat === TO_TRY
                ? toTry.has(a.id)
                : catOf(a) === cat,
        )
        .filter((a) => !topRatedOnly || isHighlyRated(a))
        // isAbandoned, not isStale: hide old-AND-quiet, never merely old.
        // Age alone flags Phantom (#9, releases via Play Store) the same as
        // dead shovelware. The offline seed is never judged at all — its
        // dates AND review counts are frozen at build time. Ratings don't
        // decay, so topRatedOnly needs no such guard.
        .filter((a) => !hideStale || offlineSeed || !isAbandoned(a))
        .sort((a, b) =>
          sort === 'newest'
            ? newestKey(b).localeCompare(newestKey(a)) ||
              b.trendScore - a.trendScore
            : sort === 'rated'
              ? bayesRating(b) - bayesRating(a) || b.trendScore - a.trendScore
              : b.trendScore - a.trendScore,
        ),
    [apps, cat, sort, watched, toTry, topRatedOnly, hideStale, offlineSeed],
  );

  const tickerItems = useMemo(() => {
    if (!apps.length) return [];
    const items: string[] = [];
    [...apps]
      .filter((a) => (a.rankDelta ?? 0) > 0)
      .sort((a, b) => (b.rankDelta ?? 0) - (a.rankDelta ?? 0))
      .slice(0, 3)
      .forEach((a) => items.push(`${a.name} ▲${a.rankDelta}`));
    [...apps]
      .filter((a) => a.firstSeen)
      .sort((a, b) => (b.firstSeen ?? '').localeCompare(a.firstSeen ?? ''))
      .slice(0, 2)
      .forEach((a) => items.push(`🆕 ${a.name}`));
    items.push(`${apps.length.toLocaleString()} apps tracked`);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const newThisWeek = apps.filter((a) => (a.firstSeen ?? '') >= weekAgo).length;
    if (newThisWeek) items.push(`${newThisWeek} new this week`);
    return items;
  }, [apps]);

  const showHeader =
    cat === 'All' && sort === 'trending' && !topRatedOnly && !hideStale;
  // A quality filter can legitimately empty a thin category — say so instead
  // of showing a blank feed, and name the filter actually responsible so the
  // user knows which chip to turn off. Takes PRECEDENCE over the watchlist
  // empty state: otherwise a user with starred apps who flips a filter on is
  // told "tap the star on any app to watch it" and thinks we lost them.
  // Blame a filter ONLY when a filter is actually what removed things. The
  // previous form was `(anyFilter) && filtered.length === 0`, which made the
  // Watching/To-try empty states unreachable whenever a chip was on: a new
  // user who had starred nothing was told "Every app here last shipped over
  // 180 days ago" about a list holding zero apps, and never saw the copy that
  // explains what starring does. That was survivable while the only filter was
  // ★4.5+ (which leaves 3% of the store, so nobody browses with it on), but
  // "hide stale" leaves 70% — a comfortable permanent browse mode.
  const emptySavedList =
    (cat === WATCHING && watched.size === 0) || (cat === TO_TRY && toTry.size === 0);
  const emptyFiltered =
    (topRatedOnly || hideStale) && filtered.length === 0 && !emptySavedList;
  const emptyReason =
    topRatedOnly && hideStale
      ? `No app here holds ${RATING_HIGH}+ with enough reviews AND shows recent signs of life.`
      : topRatedOnly
        ? `No app here holds ${RATING_HIGH}+ with enough reviews to trust it yet.`
        : `Every app here looks abandoned — no release in ${FRESH_STALE_DAYS}+ days and no recent review activity.`;
  const emptyWatching = !emptyFiltered && cat === WATCHING && filtered.length === 0;
  const emptyToTry = !emptyFiltered && cat === TO_TRY && filtered.length === 0;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Text style={styles.h1}>Discover</Text>
      <Ticker items={tickerItems} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chips}
        contentContainerStyle={styles.chipsContent}
      >
        {chips.map((c) => (
          <Pressable
            key={c}
            onPress={() => setCat(c)}
            hitSlop={{ top: 8, bottom: 8 }}
            style={[styles.chip, cat === c && styles.chipActive]}
          >
            <Text style={[styles.chipText, cat === c && styles.chipTextActive]}>
              {c}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chips}
        contentContainerStyle={styles.chipsContent}
      >
        {SORTS.map((s) => (
          <Pressable
            key={s.key}
            onPress={() => setSortHaptic(s.key)}
            hitSlop={{ top: 8, bottom: 8 }}
            style={[styles.chip, sort === s.key && styles.chipActive]}
          >
            <Text style={[styles.chipText, sort === s.key && styles.chipTextActive]}>
              {s.label}
            </Text>
          </Pressable>
        ))}
        <Pressable
          onPress={() => {
            Haptics.selectionAsync().catch(() => {});
            setTopRatedOnly((v) => !v);
          }}
          hitSlop={{ top: 8, bottom: 8 }}
          style={[styles.chip, topRatedOnly && styles.chipActive]}
        >
          <Text style={[styles.chipText, topRatedOnly && styles.chipTextActive]}>
            {`★ ${RATING_HIGH}+ only`}
          </Text>
        </Pressable>
        {/* Hidden on the offline seed: its dates are frozen, so the filter
            is deliberately inert there and a chip that does nothing is worse
            than no chip. */}
        {!offlineSeed && (
        <Pressable
          onPress={() => {
            Haptics.selectionAsync().catch(() => {});
            setHideStale((v) => !v);
          }}
          hitSlop={{ top: 8, bottom: 8 }}
          style={[styles.chip, hideStale && styles.chipActive]}
        >
          {/* "Abandoned", not "stale": the Stale badge is pure release age,
              and this filter deliberately keeps old-but-alive apps (Phantom).
              A chip named "hide stale" next to a visible Stale badge it
              didn't hide would read as a bug. */}
          <Text style={[styles.chipText, hideStale && styles.chipTextActive]}>
            🕒 Hide abandoned
          </Text>
        </Pressable>
        )}
      </ScrollView>
      {loading ? (
        <SkeletonList />
      ) : emptyFiltered ? (
        <View style={styles.empty}>
          <Text style={styles.emptyStar}>{hideStale && !topRatedOnly ? '🕒' : '★'}</Text>
          <Text style={styles.emptyText}>
            {emptyReason} Try another category, or turn the filter off.
          </Text>
        </View>
      ) : emptyWatching ? (
        <View style={styles.empty}>
          <Text style={styles.emptyStar}>☆</Text>
          <Text style={styles.emptyText}>
            Tap the star on any app to watch it. You'll get a heads-up when a
            watched app climbs the ranks or ships an update.
          </Text>
        </View>
      ) : emptyToTry ? (
        <View style={styles.empty}>
          <Text style={styles.emptyStar}>📌</Text>
          <Text style={styles.emptyText}>
            Found something worth trying? Open any app's page and tap
            “📌 Try later” — it lands here so you don't lose it.
          </Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={filtered}
          keyExtractor={(a) => a.id}
          ListHeaderComponent={<DiscoverHeader apps={apps} show={showHeader} />}
          renderItem={({ item }) => <AppCard app={item} />}
          contentContainerStyle={{ paddingBottom: 24 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[colors.green]}
              progressBackgroundColor={colors.card}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingTop: 8 },
  h1: { ...heading, paddingHorizontal: 16, marginBottom: 8 },
  // flexShrink:0 is the actual fix — a ScrollView defaults to flexShrink:1, so
  // in this column it was shrinking BELOW its content height and slicing the
  // pills' rounded bottoms flat. flexGrow:0 alone doesn't prevent that.
  chips: { flexGrow: 0, flexShrink: 0, marginBottom: 8 },
  // A horizontal ScrollView sizes to its content and was slicing the pills'
  // rounded bottoms flat (the sort row below is a plain View, so it renders
  // fine — that mismatch is the tell). Vertical padding + centering gives the
  // chips room to render their full height.
  chipsContent: {
    paddingHorizontal: 16,
    gap: 8,
    paddingVertical: 6,
    alignItems: 'center',
  },
  chip: {
    height: 34,
    justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border, borderRadius: 999,
    paddingHorizontal: 12,
  },
  chipActive: { backgroundColor: colors.green, borderColor: colors.green },
  chipText: {
    color: colors.textDim,
    fontSize: 13,
    // Fixed line box: "★" falls back to a font with taller metrics, which
    // pushed "★ Watching" down and clipped its "g" in the 34px chip.
    lineHeight: 18,
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  chipTextActive: { color: '#00140B', fontWeight: '700' },
  empty: { alignItems: 'center', paddingHorizontal: 40, paddingTop: 60 },
  emptyStar: { color: colors.textDim, fontSize: 48, marginBottom: 12 },
  emptyText: { color: colors.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
