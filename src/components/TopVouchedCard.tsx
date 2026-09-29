import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { fetchCatalog, isSeedCatalog } from '../lib/catalog';
import type { DappEntry } from '../lib/types';
import { getTopVouched, knownTopRows, lastVouchStamp, topRowMeta } from '../lib/vouch';
import type { TopWeek } from '../lib/vouch';
import { colors, fonts } from '../theme';
import { AppIcon } from './AppIcon';
import { SkeletonLines } from './Skeleton';

const ROWS = 5;
const REFRESH_MS = 60_000;

/**
 * MOST VOUCHED THIS WEEK in the Lounge: GET /vouch/top, read only. It stands
 * where the member vote was planned; the weekly vote was cut, so there are
 * no buttons and no signing here, only who Seeker owners vouched for since
 * Monday 00:00 UTC. The worker drops apps with no vouch this week, so an
 * empty list really means an empty week and says so.
 *
 * Only apps the catalog knows are listed, ranked after that filter
 * (vouchCore.knownTopRows): a raw package id is never printed as an app.
 */
export function TopVouchedCard() {
  const nav = useNavigation<any>();
  const [top, setTop] = useState<TopWeek | null>(null);
  const [failed, setFailed] = useState(false);
  const [apps, setApps] = useState<Map<string, DappEntry>>(new Map());
  // The catalog fetch fell back to the offline seed: no app list to rank against yet.
  const [catalogDown, setCatalogDown] = useState(false);
  // The same flag for the focus effect. As a dependency it would re-run that
  // effect, and fetch again, the moment a fetch failed instead of on the next focus.
  const catalogDownRef = useRef(false);
  const mounted = useRef(true);
  const lastLoad = useRef(0);
  // The vouch stamp the shown list was read after: a vouch since then re-reads on focus.
  const loadedStamp = useRef<string | undefined>(undefined);
  const seq = useRef(0);

  const load = useCallback(() => {
    lastLoad.current = Date.now();
    loadedStamp.current = lastVouchStamp();
    const mine = ++seq.current;
    setFailed(false);
    getTopVouched().then((t) => {
      if (seq.current !== mine) return;
      if (t) setTop(t);
      else setFailed(true); // keep showing the last good list, if there was one
    });
  }, []);

  // The offline seed is a few dozen apps frozen at build time: ranking the week's
  // list through it would hide nearly every vouched app, so it counts as no catalog
  // (the card offers Retry and tries again on the next focus).
  const loadCatalog = useCallback(() => {
    fetchCatalog().then((list) => {
      if (!mounted.current) return;
      if (isSeedCatalog(list)) {
        catalogDownRef.current = true;
        setCatalogDown(true);
        return;
      }
      catalogDownRef.current = false;
      setCatalogDown(false);
      setApps(new Map(list.map((a) => [a.id, a])));
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    loadCatalog();
    return () => {
      mounted.current = false;
    };
  }, [loadCatalog]);

  // Re-read when the Lounge tab comes back into view: at most once a minute
  // (the worker caches it for two), and at once after a vouch in this session.
  useFocusEffect(
    useCallback(() => {
      if (catalogDownRef.current) loadCatalog();
      if (Date.now() - lastLoad.current >= REFRESH_MS || lastVouchStamp() !== loadedStamp.current) load();
    }, [load, loadCatalog]),
  );

  const rows = apps.size ? knownTopRows(top?.apps ?? [], (id) => apps.get(id), ROWS) : [];

  return (
    <View style={styles.card}>
      <Text style={styles.label}>MOST VOUCHED THIS WEEK</Text>
      <Text style={styles.sub}>
        Seeker owners, one voice per Genesis Token. Counted from Monday 00:00 UTC.
      </Text>
      {top && apps.size > 0 ? (
        rows.length ? (
          rows.map(({ row: r, entry }, i) => (
            <Pressable
              key={r.package}
              style={styles.row}
              onPress={() => nav.navigate('AppDetail', { app: entry })}
            >
              <Text style={styles.rank}>{i + 1}</Text>
              <AppIcon uri={entry.iconUrl} size={32} />
              <View style={styles.rowBody}>
                <View style={styles.nameRow}>
                  <Text style={styles.name} numberOfLines={1}>
                    {entry.name}
                  </Text>
                  {r.worksOnSeeker && (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>Works on Seeker</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.meta} numberOfLines={2}>
                  {topRowMeta(r)}
                </Text>
              </View>
            </Pressable>
          ))
        ) : (
          <Text style={styles.empty}>
            No vouches yet this week. Vouch for the apps you use and they show up here.
          </Text>
        )
      ) : catalogDown ? (
        <View style={styles.errRow}>
          <Text style={[styles.empty, { flex: 1, marginTop: 0 }]}>Couldn't load the app list.</Text>
          <Pressable
            onPress={() => {
              loadCatalog();
              load();
            }}
            hitSlop={10}
          >
            <Text style={styles.link}>Retry</Text>
          </Pressable>
        </View>
      ) : failed ? (
        <View style={styles.errRow}>
          <Text style={[styles.empty, { flex: 1, marginTop: 0 }]}>Couldn't load this week's vouches.</Text>
          <Pressable onPress={load} hitSlop={10}>
            <Text style={styles.link}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ marginTop: 12 }}>
          <SkeletonLines widths={['70%', '55%', '62%']} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card, borderRadius: 14, padding: 14,
    marginHorizontal: 16, marginTop: 16,
    borderWidth: 1, borderColor: colors.border,
  },
  label: { color: colors.purple, fontSize: 11, fontWeight: '800', letterSpacing: 1.1 },
  sub: { color: colors.textDim, fontSize: 12, lineHeight: 17, marginTop: 6 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8,
    marginTop: 4,
  },
  rank: {
    color: colors.textDim, fontSize: 12, fontWeight: '800', width: 16, textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  rowBody: { flex: 1, minWidth: 0 },
  // The badge sits on the name line so the meta line keeps the full width.
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flexShrink: 1, color: colors.text, fontSize: 14, fontFamily: fonts.semi },
  meta: { color: colors.textDim, fontSize: 11, lineHeight: 15, marginTop: 2, fontVariant: ['tabular-nums'] },
  badge: {
    borderWidth: 1, borderColor: colors.purple, borderRadius: 8,
    paddingHorizontal: 5, paddingVertical: 1,
  },
  badgeText: { color: colors.purple, fontSize: 9, fontWeight: '700' },
  empty: { color: colors.textDim, fontSize: 13, lineHeight: 19, marginTop: 12 },
  errRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  link: { color: colors.green, fontSize: 12, fontWeight: '800' },
});
