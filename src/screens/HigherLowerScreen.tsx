import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { AppIcon } from '../components/AppIcon';
import { BackHeader } from '../components/BackHeader';
import { fetchCatalog, onLiveCatalog } from '../lib/catalog';
import { clearToken, sendMessage } from '../lib/chat';
import { catOf } from '../lib/collections';
import {
  GameError,
  getToday,
  HolApp,
  sendPick,
  shareText,
  Today,
  untilNext,
} from '../lib/game';
import { DappEntry } from '../lib/types';
import { useLoungeToken } from '../lib/useLounge';
import { colors, fonts } from '../theme';
import { SeatGate } from './GuessScreen';

const REVEAL_MS = 1100;
const PRACTICE_BEST_KEY = 'seekerscout.hol.practiceBest.v1';
const fmt = (v?: number) => (typeof v === 'number' ? v.toLocaleString('en-US') : '?');

type Pick = 'higher' | 'lower';
type Reveal = { a: HolApp; b: HolApp; correct: boolean } | null;

/**
 * Practice runs are generated on the device from the public catalog, so
 * anyone can play. They are never ranked or shareable: a result the server
 * didn't witness can't sit on a board that promises fairness.
 */
function usePractice(catalog: DappEntry[]) {
  const pool = useMemo(
    () =>
      catalog
        .filter((a) => (a.reviews ?? 0) >= 150 && a.iconUrl)
        .map((a) => ({ id: a.id, n: a.name, c: catOf(a), i: a.iconUrl, v: a.reviews })),
    [catalog],
  );
  const nextAfter = useCallback(
    (prev: HolApp, used: Set<string>, step: number): HolApp | null => {
      const want = step <= 5 ? 2.2 : step <= 15 ? 1.6 : 1.25;
      for (let t = 0; t < 400; t++) {
        const c = pool[Math.floor(Math.random() * pool.length)];
        if (!c || used.has(c.id) || !prev.v || !c.v) continue;
        const r = c.v > prev.v ? c.v / prev.v : prev.v / c.v;
        if (r >= want) return c;
      }
      return null;
    },
    [pool],
  );
  return { pool, nextAfter };
}

export function HigherLowerScreen() {
  const nav = useNavigation<any>();
  const lounge = useLoungeToken();
  const [catalog, setCatalog] = useState<DappEntry[]>([]);
  const [today, setToday] = useState<Today | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<Reveal>(null);
  const [shared, setShared] = useState(false);
  const [mode, setMode] = useState<'ranked' | 'practice'>('ranked');
  const fade = useRef(new Animated.Value(0)).current;

  // Practice state
  const { pool, nextAfter } = usePractice(catalog);
  const [pr, setPr] = useState<{ a: HolApp; b: HolApp; step: number; score: number; used: Set<string>; over: boolean } | null>(null);
  const [practiceBest, setPracticeBest] = useState(0);

  useEffect(() => {
    fetchCatalog().then(setCatalog);
    AsyncStorage.getItem(PRACTICE_BEST_KEY)
      .then((v) => setPracticeBest(Number(v) || 0))
      .catch(() => {});
    // A live catalog that lands after the offline seed widens the practice pool.
    return onLiveCatalog(setCatalog);
  }, []);

  const load = useCallback(async (token: string) => {
    setLoading(true);
    setError(undefined);
    try {
      setToday(await getToday(token));
    } catch (e) {
      if (e instanceof GameError && e.status === 401) await clearToken();
      else setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (lounge.token) {
      setMode('ranked');
      load(lounge.token);
    } else {
      setToday(null);
    }
  }, [lounge.token, load]);

  const startPractice = useCallback(() => {
    if (pool.length < 10) return;
    const a = pool[Math.floor(Math.random() * pool.length)];
    const used = new Set([a.id]);
    const b = nextAfter(a, used, 1);
    if (!b) return;
    used.add(b.id);
    setPr({ a, b, step: 1, score: 0, used, over: false });
    setMode('practice');
  }, [pool, nextAfter]);

  const showReveal = (r: NonNullable<Reveal>) => {
    setReveal(r);
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 260, useNativeDriver: true }).start();
    Haptics.notificationAsync(
      r.correct ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error,
    ).catch(() => {});
  };

  async function pickRanked(pick: Pick) {
    if (!lounge.token || !today || busy || reveal) return;
    setBusy(true);
    setError(undefined);
    try {
      const hol = await sendPick(lounge.token, pick, today.day);
      const last = hol.history[hol.history.length - 1];
      showReveal({ a: last.a, b: last.b, correct: last.correct });
      setTimeout(() => {
        setReveal(null);
        setToday((t) => (t ? { ...t, hol } : t));
        if (hol.done && lounge.token) load(lounge.token);
      }, REVEAL_MS);
    } catch (e) {
      if (e instanceof GameError && e.status === 401) await clearToken();
      else if (e instanceof GameError && e.stale) await load(lounge.token); // new day's run
      else setError(e instanceof Error ? e.message : 'Pick failed.');
    } finally {
      setBusy(false);
    }
  }

  function pickPractice(pick: Pick) {
    if (!pr || pr.over || reveal) return;
    const correct = (pick === 'higher' && (pr.b.v ?? 0) > (pr.a.v ?? 0)) ||
      (pick === 'lower' && (pr.b.v ?? 0) < (pr.a.v ?? 0));
    showReveal({ a: pr.a, b: pr.b, correct });
    setTimeout(() => {
      setReveal(null);
      if (!correct) {
        setPr({ ...pr, over: true });
        if (pr.score > practiceBest) {
          setPracticeBest(pr.score);
          AsyncStorage.setItem(PRACTICE_BEST_KEY, String(pr.score)).catch(() => {});
        }
        return;
      }
      const used = new Set(pr.used);
      const next = nextAfter(pr.b, used, pr.step + 1);
      if (!next) {
        setPr({ ...pr, score: pr.score + 1, over: true });
        return;
      }
      used.add(next.id);
      setPr({ a: pr.b, b: next, step: pr.step + 1, score: pr.score + 1, used, over: false });
    }, REVEAL_MS);
  }

  async function share() {
    if (!lounge.token || !today) return;
    try {
      await sendMessage(lounge.token, shareText(today));
      setShared(true);
      nav.navigate('Chat');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not post to the Lounge.');
    }
  }

  // What to draw: a reveal in progress beats the live pair.
  const ranked = mode === 'ranked' && !!today;
  const pair = reveal
    ? { a: reveal.a, b: reveal.b }
    : ranked
      ? today!.hol.current
      : pr && !pr.over
        ? { a: pr.a, b: pr.b }
        : null;
  const score = ranked ? today!.hol.score : pr?.score ?? 0;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <BackHeader
        title="Higher or Lower"
        right={<Text style={styles.streak}>🔥 {score}</Text>}
      />
      <ScrollView contentContainerStyle={styles.body}>
        {!lounge.ready || (loading && !today) ? (
          <ActivityIndicator color={colors.purple} style={{ marginTop: 40 }} />
        ) : mode === 'practice' || !lounge.token ? (
          <>
            {!lounge.token && (
              <View style={styles.practiceNote}>
                <Text style={styles.practiceText}>
                  Practice mode. Verify your Lounge seat to play today's ranked run.
                </Text>
              </View>
            )}
            {pr && !pr.over && pair ? (
              <Board pair={pair} reveal={reveal} fade={fade} onPick={pickPractice} disabled={!!reveal} step={pr.step} />
            ) : (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>
                  {pr?.over ? `Practice over: ${pr.score}` : 'Which app has more reviews?'}
                </Text>
                <Text style={styles.cardBody}>
                  Two apps, one question. Keep going until you miss.
                  {practiceBest ? ` Your practice best is ${practiceBest}.` : ''}
                </Text>
                <Pressable
                  style={[styles.btn, pool.length < 10 && styles.btnDim]}
                  onPress={startPractice}
                  disabled={pool.length < 10}
                >
                  <Text style={styles.btnText}>{pr ? 'Practice again' : 'Start practice'}</Text>
                </Pressable>
              </View>
            )}
            {!lounge.token && (
              <SeatGate lounge={lounge} onClaim={() => nav.navigate('Tabs', { screen: 'Lounge' })} />
            )}
            {!!lounge.token && (
              <Pressable style={styles.btnGhost} onPress={() => setMode('ranked')}>
                <Text style={styles.btnGhostText}>Back to today's ranked run</Text>
              </Pressable>
            )}
          </>
        ) : !today ? (
          <Text style={styles.err}>{error ?? "Couldn't load today's run."}</Text>
        ) : today.hol.done && !reveal ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              {today.hol.score >= today.hol.length ? `Perfect run! ${today.hol.score} 🔥` : `Run over: ${today.hol.score} in a row`}
            </Text>
            <Text style={styles.cardBody}>
              +{today.hol.points} pts · week {today.week.score} pts
              {today.week.rank ? ` (#${today.week.rank})` : ''}
            </Text>
            <Pressable style={[styles.btn, shared && styles.btnDim]} onPress={share} disabled={shared}>
              <Text style={styles.btnText}>{shared ? 'Shared ✓' : 'Share to the Lounge'}</Text>
            </Pressable>
            {!today.guess.done && (
              <Pressable style={styles.btnGhost} onPress={() => nav.navigate('Guess')}>
                <Text style={styles.btnGhostText}>Play Guess the dApp →</Text>
              </Pressable>
            )}
            <Pressable style={styles.btnGhost} onPress={startPractice}>
              <Text style={styles.btnGhostText}>Keep playing in practice</Text>
            </Pressable>
            <Text style={styles.next}>New ranked run in {untilNext(today.nextAt)}</Text>
          </View>
        ) : pair ? (
          <Board
            pair={pair}
            reveal={reveal}
            fade={fade}
            onPick={pickRanked}
            disabled={busy || !!reveal}
            // `today` only updates AFTER the reveal, so during a reveal it
            // still holds the pre-pick step: the round on screen is always
            // step + 1, before and during the reveal alike.
            step={today.hol.step + 1}
            of={today.hol.length}
          />
        ) : null}
        {!!error && <Text style={styles.err}>{error}</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}

function Board({
  pair,
  reveal,
  fade,
  onPick,
  disabled,
  step,
  of,
}: {
  pair: { a: HolApp; b: HolApp };
  reveal: Reveal;
  fade: Animated.Value;
  onPick: (p: Pick) => void;
  disabled: boolean;
  step: number;
  of?: number;
}) {
  return (
    <View>
      <Text style={styles.progress}>{of ? `${Math.min(step, of)} of ${of}` : `Round ${step}`}</Text>
      <AppPanel app={pair.a} shown />
      <Text style={styles.vs}>VS</Text>
      <AppPanel app={pair.b} shown={!!reveal} fade={fade} verdict={reveal?.correct} />
      {/* Asked about the HIDDEN app, because that's what the buttons answer.
          "A, more or fewer than, B" read as a question about A. */}
      <Text style={styles.question}>
        Does <Text style={styles.questionApp}>{pair.b.n}</Text> have more or fewer
        reviews than <Text style={styles.questionApp}>{pair.a.n}</Text>?
      </Text>
      <View style={styles.picks}>
        <Pressable
          style={({ pressed }) => [styles.pick, styles.pickUp, (disabled || pressed) && styles.btnDim]}
          onPress={() => onPick('higher')}
          disabled={disabled}
        >
          <Text style={styles.pickText}>▲ More</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.pick, styles.pickDown, (disabled || pressed) && styles.btnDim]}
          onPress={() => onPick('lower')}
          disabled={disabled}
        >
          <Text style={styles.pickText}>▼ Fewer</Text>
        </Pressable>
      </View>
    </View>
  );
}

function AppPanel({
  app,
  shown,
  fade,
  verdict,
}: {
  app: HolApp;
  shown: boolean;
  fade?: Animated.Value;
  verdict?: boolean;
}) {
  const border =
    verdict === undefined ? colors.border : verdict ? colors.green : colors.red;
  return (
    <View style={[styles.panel, { borderColor: border }]}>
      <AppIcon uri={app.i} size={56} />
      <View style={{ flex: 1 }}>
        <Text style={styles.panelName} numberOfLines={1}>
          {app.n}
        </Text>
        <Text style={styles.panelCat} numberOfLines={1}>
          {app.c}
        </Text>
        {shown && typeof app.v === 'number' ? (
          <Animated.Text style={[styles.panelCount, fade ? { opacity: fade } : null]}>
            {fmt(app.v)} reviews
          </Animated.Text>
        ) : (
          <Text style={styles.panelHidden}>? reviews</Text>
        )}
      </View>
      {verdict !== undefined && <Text style={styles.verdict}>{verdict ? '✅' : '❌'}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 16, paddingBottom: 40 },
  streak: { color: colors.yellow, fontFamily: fonts.heavy, fontSize: 15 },
  progress: { color: colors.textDim, fontSize: 12, fontWeight: '700', marginBottom: 10 },
  panel: {
    flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: colors.card,
    borderRadius: 16, padding: 14, borderWidth: 1.5,
  },
  panelName: { color: colors.text, fontSize: 17, fontFamily: fonts.heavy },
  panelCat: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  panelCount: { color: colors.green, fontSize: 20, fontFamily: fonts.heavy, marginTop: 6, fontVariant: ['tabular-nums'] },
  panelHidden: { color: colors.purple, fontSize: 20, fontFamily: fonts.heavy, marginTop: 6 },
  verdict: { fontSize: 22 },
  vs: { color: colors.textDim, fontSize: 12, textAlign: 'center', marginVertical: 10, fontWeight: '700' },
  question: { color: colors.text, fontSize: 15, lineHeight: 21, textAlign: 'center', marginTop: 16 },
  questionApp: { fontFamily: fonts.heavy },
  picks: { flexDirection: 'row', gap: 10, marginTop: 14 },
  pick: { flex: 1, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  pickUp: { backgroundColor: colors.green },
  pickDown: { backgroundColor: colors.purple },
  pickText: { color: '#0B0B0F', fontSize: 16, fontFamily: fonts.heavy },
  card: {
    backgroundColor: colors.card, borderRadius: 16, padding: 16,
    borderWidth: 1, borderColor: colors.purple, marginBottom: 12,
  },
  cardTitle: { color: colors.text, fontSize: 19, fontFamily: fonts.heavy },
  cardBody: { color: colors.textDim, fontSize: 13, lineHeight: 19, marginTop: 8 },
  practiceNote: {
    backgroundColor: colors.cardNested, borderRadius: 10, padding: 10, marginBottom: 12,
  },
  practiceText: { color: colors.textDim, fontSize: 12 },
  btn: {
    backgroundColor: colors.purple, borderRadius: 12, marginTop: 14,
    paddingVertical: 13, alignItems: 'center', minHeight: 46, justifyContent: 'center',
  },
  btnDim: { opacity: 0.55 },
  btnText: { color: colors.text, fontWeight: '800', fontSize: 14 },
  btnGhost: {
    borderWidth: 1, borderColor: colors.purple, borderRadius: 12, marginTop: 10,
    paddingVertical: 12, alignItems: 'center',
  },
  btnGhostText: { color: colors.purple, fontWeight: '800', fontSize: 14 },
  next: { color: colors.textDim, fontSize: 12, textAlign: 'center', marginTop: 12 },
  err: { color: colors.red, fontSize: 13, marginTop: 12 },
});
