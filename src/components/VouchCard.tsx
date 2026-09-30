import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { fetchRemoteFlags } from '../lib/catalog';
import { useWalletSession } from '../lib/session';
import type { DappEntry } from '../lib/types';
import {
  atVouchLimit,
  chipHint,
  getAppVouches,
  getCachedResult,
  getCachedWeight,
  getMyVouches,
  lastVouchStamp,
  LIMIT_SENTENCE,
  ownState,
  tagLabels,
  tierLabel,
  verdictLabel,
  vouchErrorMessage,
  walletChip,
  WEIGHT_CAPTION,
} from '../lib/vouch';
import type { AppVouches, AppVouchSummary, MyVouch, RemoteFlags, VouchResult } from '../lib/vouch';
import { colors, fonts } from '../theme';
import { SkeletonLines } from './Skeleton';

const RECENT_SHOWN = 3;

// A 200 that could not be read: the vouch may have landed, and its sentence says it was sent.
const MAYBE_LANDED = vouchErrorMessage(200, 'unexpected response');

/**
 * SEEKER OWNERS SAY: Scout Vouch on an app page. A sibling of the rating
 * histogram, never inside it, because the histogram hides below 5 reviews.
 *
 * Numbers and notes are live from the worker (GET /vouch/app). The owner's
 * own verdict comes from GET /vouch/mine; its tags, note and weight only
 * from this device's signed answers, because the worker serves none of
 * them by mint. The weight is cachedWeight's: a vouch on another app can
 * re-stamp this one, so this app's own answer alone goes stale. After a
 * vouch the sheet hands its answer over (`lastResult`) so the numbers move
 * at once: the public read is cached on the phone for a minute, so the
 * follow-up read of the notes goes past that cache.
 */
export function VouchCard({
  app,
  lastResult,
  onVouch,
  failedSentence,
}: {
  app: DappEntry;
  lastResult: VouchResult | null;
  onVouch: () => void;
  /** Set when the last vouch failed after its sheet was closed. */
  failedSentence?: string;
}) {
  const session = useWalletSession();
  const mint = session?.mint;
  const [data, setData] = useState<AppVouches | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [flags, setFlags] = useState<RemoteFlags | null>(null);
  const [mine, setMine] = useState<MyVouch[] | null>(null);
  const [cached, setCached] = useState<VouchResult | null>(null);
  const [weight, setWeight] = useState<number | null>(null);
  const [ownReady, setOwnReady] = useState(false);
  // Newest request wins: a slow read started before a vouch must not paint over the vouch's numbers.
  const readSeq = useRef(0);
  const ownSeq = useRef(0);
  // The session's vouch stamp the weight was read after: a vouch since then (on another app) re-reads it on focus.
  const weightStamp = useRef<string | undefined>(undefined);

  useEffect(() => {
    const seq = ++readSeq.current;
    setLoading(true);
    getAppVouches(app.id).then((r) => {
      if (readSeq.current !== seq) return;
      if (r) setData(r);
      setLoading(false);
    });
  }, [app.id, reload]);

  useEffect(() => {
    let live = true;
    fetchRemoteFlags().then((f) => live && setFlags(f));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const seq = ++ownSeq.current;
    if (!mint) {
      setMine(null);
      setCached(null);
      setWeight(null);
      setOwnReady(true);
      return;
    }
    setOwnReady(false);
    weightStamp.current = lastVouchStamp();
    Promise.all([getMyVouches(mint), getCachedResult(mint, app.id), getCachedWeight(mint, app.id)]).then(
      ([m, c, w]) => {
        if (ownSeq.current !== seq) return;
        setMine(m);
        setCached(c);
        setWeight(w);
        setOwnReady(true);
      },
    );
  }, [mint, app.id]);

  // Back on this page after a vouch on another app page: that vouch may have
  // re-stamped this one's weight, so read it again (the sheet does on open).
  useFocusEffect(
    useCallback(() => {
      if (!mint || lastVouchStamp() === weightStamp.current) return;
      weightStamp.current = lastVouchStamp();
      const seq = ownSeq.current;
      getCachedWeight(mint, app.id).then((w) => {
        if (ownSeq.current === seq) setWeight(w);
      });
    }, [mint, app.id]),
  );

  // A vouch just landed on this app: its signed answer carries the fresh numbers and the owner's state.
  useEffect(() => {
    if (!lastResult || lastResult.vouch.package !== app.id) return;
    ownSeq.current += 1;
    const seq = ++readSeq.current;
    setData((d) => ({ app: lastResult.app, recent: d?.recent ?? [] }));
    setLoading(false);
    setMine((m) => [
      ...(m ?? []).filter((x) => x.package !== app.id),
      {
        package: app.id,
        verdict: lastResult.vouch.verdict,
        noteHidden: lastResult.vouch.noteHidden,
        excluded: lastResult.vouch.excluded,
      },
    ]);
    setCached(lastResult);
    setWeight(lastResult.weight);
    weightStamp.current = lastVouchStamp();
    setOwnReady(true);
    getAppVouches(app.id, lastResult.vouch.updatedAt || String(Date.now())).then((r) => {
      if (readSeq.current === seq && r) setData(r);
    });
  }, [lastResult, app.id]);

  const summary = data?.app ?? null;
  const recent = (data?.recent ?? []).slice(0, RECENT_SHOWN);
  const state = mint ? ownState(mine, cached, app.id) : { kind: 'none' as const };

  // Past the worker's 50-app cap a new app would cost a Seed Vault prompt for a certain 403.
  const atLimit = atVouchLimit(mine, app.id);

  let own: React.ReactNode = null;
  if (flags && ownReady) {
    const paused = <Text style={styles.dim}>Vouching is paused right now.</Text>;
    if (session?.genesis === 'not-found') {
      own = (
        <>
          <Text style={styles.dim}>
            No Genesis Token in the connected wallet, so vouching stays read-only for you.
          </Text>
          {flags.vouch && (
            <Pressable style={styles.ghost} onPress={onVouch}>
              <Text style={styles.ghostText}>Connect another wallet</Text>
            </Pressable>
          )}
        </>
      );
    } else if (state.kind === 'excluded') {
      own = <Text style={styles.dim}>Your vouch was removed by the operator.</Text>;
    } else if (state.kind === 'mine') {
      const d = state.detail;
      own = (
        <View style={styles.own}>
          <Text style={styles.ownLine}>
            You said:{' '}
            <Text style={{ color: state.verdict === 'works' ? colors.green : colors.red }}>
              {verdictLabel(state.verdict)}
            </Text>
            {d ? ` · counts ${(weight ?? d.result.weight).toFixed(2)}x` : ''}
          </Text>
          {!!d && d.tags.length > 0 && <Text style={styles.ownMeta}>{tagLabels(d.tags)}</Text>}
          {!!d && !!d.note && !state.noteHidden && <Text style={styles.ownNote}>“{d.note}”</Text>}
          {state.noteHidden && (
            <Text style={styles.dim}>Your note was hidden by moderation; your verdict still counts.</Text>
          )}
          {flags.vouch ? (
            <Pressable style={styles.ghost} onPress={onVouch}>
              <Text style={styles.ghostText}>Change your vouch</Text>
            </Pressable>
          ) : (
            paused
          )}
        </View>
      );
    } else if (!flags.vouch) {
      own = paused;
    } else if (atLimit) {
      own = <Text style={styles.dim}>{LIMIT_SENTENCE}</Text>;
    } else {
      own = (
        <Pressable style={styles.btn} onPress={onVouch}>
          <Text style={styles.btnText}>Vouch for this app</Text>
        </Pressable>
      );
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.label}>SEEKER OWNERS SAY</Text>
      {summary ? (
        <Numbers s={summary} />
      ) : loading ? (
        <SkeletonLines />
      ) : (
        <View style={styles.errRow}>
          <Text style={[styles.body, { flex: 1 }]}>Couldn't load owner vouches.</Text>
          <Pressable onPress={() => setReload((n) => n + 1)} hitSlop={10}>
            <Text style={styles.link}>Retry</Text>
          </Pressable>
        </View>
      )}

      {own}

      {!!failedSentence && (
        <Text style={styles.failed} accessibilityLiveRegion="polite">
          {failedSentence === MAYBE_LANDED
            ? failedSentence
            : `Your last vouch did not go through. ${failedSentence}`}
        </Text>
      )}

      {recent.length > 0 && (
        <>
          <Text style={[styles.label, styles.notesLabel]}>RECENT NOTES</Text>
          {recent.map((n) => (
            <View key={n.id} style={styles.noteRow}>
              <Text
                style={[styles.glyph, { color: n.verdict === 'works' ? colors.green : colors.red }]}
                accessibilityLabel={verdictLabel(n.verdict)}
              >
                {n.verdict === 'works' ? '✓' : '✕'}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.noteText}>{n.note}</Text>
                {/* No weight here: a weight next to a Lounge number would tell every
                    reader roughly what that owner stakes (VouchNote carries none). */}
                <Text style={styles.noteMeta}>
                  {[tierLabel(n.number, n.tier), n.tags.length ? tagLabels(n.tags) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
            </View>
          ))}
        </>
      )}
    </View>
  );
}

function Numbers({ s }: { s: AppVouchSummary }) {
  if (s.voices === 0) {
    return <Text style={styles.body}>No owner has vouched for this app yet. Be the first.</Text>;
  }
  const hint = chipHint(s);
  const chip = walletChip(s.walletOkVoices);
  return (
    <>
      <View style={styles.stats}>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{s.voices}</Text>
          <Text style={styles.statSub}>{s.voices === 1 ? 'owner vouched' : 'owners vouched'}</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{s.worksPct}%</Text>
          <Text style={styles.statSub}>say it works</Text>
        </View>
      </View>
      {(s.worksOnSeeker || s.walletOkVoices > 0) && (
        <View style={styles.badges}>
          {s.worksOnSeeker && (
            <View style={[styles.badge, { borderColor: colors.purple }]}>
              <Text style={[styles.badgeText, { color: colors.purple }]}>Works on Seeker</Text>
            </View>
          )}
          {s.walletOkVoices > 0 && (
            <View
              style={[styles.badge, { borderColor: colors.purple }]}
              accessible
              accessibilityLabel={chip.a11y}
            >
              <Text style={[styles.badgeText, { color: colors.purple }]}>{chip.text}</Text>
            </View>
          )}
        </View>
      )}
      {!!hint && <Text style={styles.dim}>{hint}</Text>}
      <Text style={styles.dim}>{WEIGHT_CAPTION}</Text>
    </>
  );
}

const styles = StyleSheet.create({
  failed: { color: colors.red, fontSize: 12, lineHeight: 17, marginTop: 8 },
  // histCard / histLabel recipes from AppDetailScreen.
  card: {
    backgroundColor: colors.card, borderRadius: 14,
    borderWidth: 1, borderColor: colors.border,
    marginHorizontal: 16, marginTop: 18, padding: 14,
  },
  label: {
    color: colors.textDim, fontSize: 10, fontWeight: '800',
    letterSpacing: 0.8, marginBottom: 10,
  },
  notesLabel: { marginTop: 16, marginBottom: 6 },
  body: { color: colors.text, fontSize: 13, lineHeight: 19 },
  dim: { color: colors.textDim, fontSize: 12, lineHeight: 17, marginTop: 8 },
  link: { color: colors.green, fontSize: 12, fontWeight: '800' },
  errRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stats: { flexDirection: 'row', gap: 10 },
  stat: {
    flex: 1, backgroundColor: colors.cardNested, borderRadius: 12,
    borderWidth: 1, borderColor: colors.border, padding: 10,
  },
  statValue: {
    color: colors.text, fontSize: 18, fontFamily: fonts.heavy,
    fontVariant: ['tabular-nums'],
  },
  statSub: { color: colors.textDim, fontSize: 10, marginTop: 2 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 10 },
  badge: {
    borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  badgeText: { fontSize: 10, fontWeight: '700' },
  own: {
    marginTop: 14, paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
  },
  ownLine: { color: colors.text, fontSize: 14, fontFamily: fonts.semi },
  ownMeta: { color: colors.textDim, fontSize: 12, marginTop: 4 },
  ownNote: { color: colors.text, fontSize: 13, lineHeight: 19, marginTop: 6 },
  // ProfileScreen btn without the outer margin, and its Disconnect ghost.
  btn: {
    backgroundColor: colors.purple, borderRadius: 12, marginTop: 14,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center',
    minHeight: 48,
  },
  btnText: { color: colors.text, fontWeight: '800', fontSize: 15 },
  ghost: {
    marginTop: 12, paddingVertical: 10, borderRadius: 10,
    borderWidth: 1, borderColor: colors.border, alignItems: 'center',
  },
  ghostText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  noteRow: { flexDirection: 'row', gap: 10, paddingVertical: 8 },
  glyph: { fontSize: 14, fontWeight: '800', width: 16, textAlign: 'center', marginTop: 1 },
  noteText: { color: colors.text, fontSize: 13, lineHeight: 19 },
  noteMeta: { color: colors.textDim, fontSize: 11, marginTop: 3 },
});
