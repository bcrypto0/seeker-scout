import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { AppIcon } from '../components/AppIcon';
import { BackHeader } from '../components/BackHeader';
import { fetchCatalog, onLiveCatalog } from '../lib/catalog';
import { clearToken, sendMessage } from '../lib/chat';
import {
  Dir,
  GameError,
  streakLabel,
  getToday,
  GuessRow,
  isGuessable,
  sendGuess,
  shareText,
  Today,
  untilNext,
} from '../lib/game';
import { DappEntry } from '../lib/types';
import { useLoungeToken } from '../lib/useLounge';
import { colors, fonts } from '../theme';

const fmtCount = (v: number) =>
  v >= 10_000 ? `${Math.round(v / 1000)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);

/** The arrow says where TODAY'S app sits relative to your guess. */
const arrow = (d: Dir, eqMark: string) =>
  d === 'up' ? '↑' : d === 'down' ? '↓' : d === 'eq' ? eqMark : '?';

export function GuessScreen() {
  const nav = useNavigation<any>();
  const lounge = useLoungeToken();
  const [today, setToday] = useState<Today | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [catalog, setCatalog] = useState<DappEntry[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  // While typing, keep the box and its suggestions above the keyboard: the
  // input sits under the clue board, so without this the list opens
  // off-screen.
  const typing = query.trim().length > 0;
  const toEnd = () => scrollRef.current?.scrollToEnd({ animated: true });

  useEffect(() => {
    fetchCatalog().then(setCatalog);
    return onLiveCatalog(setCatalog); // a live catalog that lands after the offline seed
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
    if (lounge.token) load(lounge.token);
    else setToday(null);
  }, [lounge.token, load]);

  const byId = useMemo(() => new Map(catalog.map((a) => [a.id, a])), [catalog]);
  const pool = useMemo(() => catalog.filter(isGuessable), [catalog]);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 1 || !today) return [];
    const tried = new Set(today.guess.guesses.map((g) => g.id));
    const hits = pool.filter((a) => !tried.has(a.id) && a.name.toLowerCase().includes(q));
    // Names that START with the query first, then by popularity.
    hits.sort((x, y) => {
      const xs = x.name.toLowerCase().startsWith(q) ? 0 : 1;
      const ys = y.name.toLowerCase().startsWith(q) ? 0 : 1;
      return xs - ys || (y.reviews ?? 0) - (x.reviews ?? 0);
    });
    return hits.slice(0, 6);
  }, [query, pool, today]);

  async function guess(app: DappEntry) {
    if (!lounge.token || !today || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const g = await sendGuess(lounge.token, app.id, today.day);
      setQuery('');
      const last = g.guesses[g.guesses.length - 1];
      Haptics.notificationAsync(
        last?.correct
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Warning,
      ).catch(() => {});
      setToday({ ...today, guess: g });
      // Finishing changes the streak and the weekly score: re-read them.
      if (g.done) load(lounge.token);
    } catch (e) {
      if (e instanceof GameError && e.status === 401) await clearToken();
      else if (e instanceof GameError && e.stale) {
        setQuery('');
        await load(lounge.token); // a new day's puzzle started: show it
      } else setError(e instanceof Error ? e.message : 'Guess failed.');
    } finally {
      setBusy(false);
    }
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

  const g = today?.guess;
  const left = g ? g.maxGuesses - g.guesses.length : 0;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <BackHeader
        title="Guess the dApp"
        right={today ? <Text style={styles.no}>#{today.puzzleNo}</Text> : null}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => typing && toEnd()}
        >
          {!lounge.ready || (loading && !today) ? (
            <ActivityIndicator color={colors.purple} style={{ marginTop: 40 }} />
          ) : !lounge.token ? (
            <SeatGate lounge={lounge} onClaim={() => nav.navigate('Tabs', { screen: 'Lounge' })} />
          ) : !g ? (
            <Text style={styles.err}>{error ?? "Couldn't load today's puzzle."}</Text>
          ) : (
            <>
              <Text style={styles.intro}>
                One mystery app from the dApp Store. Each guess tells you how
                today's app compares, and every miss unlocks a clue.
              </Text>

              <ClueBoard today={today} />

              {g.guesses.length > 0 && (
                <View style={{ gap: 8, marginTop: 16 }}>
                  {g.guesses.map((row) => (
                    <GuessLine key={row.id} row={row} />
                  ))}
                  <Text style={styles.legend}>↑ ↓ show where today's app sits. ≈ within 10%.</Text>
                </View>
              )}

              {g.done ? (
                <Result
                  today={today}
                  shared={shared}
                  onShare={share}
                  onOpen={() => {
                    const app = g.answer && byId.get(g.answer.id);
                    if (app) nav.navigate('AppDetail', { app });
                  }}
                  onHol={() => nav.navigate('HigherLower')}
                />
              ) : (
                <View style={styles.inputWrap}>
                  <Text style={styles.left}>
                    {left} {left === 1 ? 'guess' : 'guesses'} left
                  </Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Type an app name…"
                    placeholderTextColor={colors.textDim}
                    value={query}
                    onChangeText={setQuery}
                    autoCorrect={false}
                    autoCapitalize="none"
                    editable={!busy}
                    // After the keyboard has resized the window.
                    onFocus={() => setTimeout(toEnd, 300)}
                  />
                  {suggestions.map((a) => (
                    <Pressable
                      key={a.id}
                      style={({ pressed }) => [styles.sugg, pressed && { opacity: 0.6 }]}
                      onPress={() => guess(a)}
                      disabled={busy}
                    >
                      <AppIcon uri={a.iconUrl} size={32} />
                      <Text style={styles.suggName} numberOfLines={1}>
                        {a.name}
                      </Text>
                    </Pressable>
                  ))}
                  {busy && <ActivityIndicator color={colors.purple} style={{ marginTop: 8 }} />}
                </View>
              )}
              {!!error && <Text style={styles.err}>{error}</Text>}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ClueBoard({ today }: { today: Today }) {
  const { clues, maxGuesses, done } = today.guess;
  const slots = Array.from({ length: maxGuesses }, (_, i) => clues[i] ?? null);
  return (
    <View style={styles.board}>
      {slots.map((c, i) => (
        <View key={i} style={[styles.clue, !c && styles.clueLocked]}>
          {c ? (
            <>
              <Text style={styles.clueLabel}>{c.label.toUpperCase()}</Text>
              {c.key === 'icon' && c.value ? (
                // Blurred while you're still guessing, sharp once it's over:
                // the last clue should help, not give it away outright.
                <Image
                  source={{ uri: c.value }}
                  style={styles.clueIcon}
                  blurRadius={done ? 0 : 6}
                />
              ) : (
                <Text style={styles.clueValue} numberOfLines={3}>
                  {c.value}
                </Text>
              )}
            </>
          ) : (
            <Text style={styles.lockedText}>🔒 unlocks after a miss</Text>
          )}
        </View>
      ))}
    </View>
  );
}

function GuessLine({ row }: { row: GuessRow }) {
  return (
    <View style={[styles.gRow, row.correct && styles.gRowRight]}>
      <View style={styles.gHead}>
        <AppIcon uri={row.iconUrl ?? undefined} size={28} />
        <Text style={styles.gName} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={styles.gMark}>{row.correct ? '✅' : '❌'}</Text>
      </View>
      {!row.correct && (
        <View style={styles.chips}>
          <Chip ok={row.category.match} text={`${row.category.match ? '✓' : '✗'} ${row.category.value}`} />
          <Chip
            ok={row.reviews.dir === 'eq'}
            text={`${arrow(row.reviews.dir, '≈')} ${fmtCount(row.reviews.value)} reviews`}
          />
          <Chip
            ok={row.rating.dir === 'eq'}
            text={`${arrow(row.rating.dir, '=')} ${Number(row.rating.value).toFixed(1)}★`}
          />
        </View>
      )}
    </View>
  );
}

function Chip({ ok, text }: { ok: boolean; text: string }) {
  return (
    <View style={[styles.chip, ok && styles.chipOk]}>
      <Text style={[styles.chipText, ok && styles.chipTextOk]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

function Result({
  today,
  shared,
  onShare,
  onOpen,
  onHol,
}: {
  today: Today;
  shared: boolean;
  onShare: () => void;
  onOpen: () => void;
  onHol: () => void;
}) {
  const g = today.guess;
  const a = g.answer;
  return (
    <View style={styles.result}>
      <Text style={styles.resultTitle}>
        {g.solved ? `Solved in ${g.guesses.length}! 🎉` : 'Out of guesses'}
      </Text>
      {a && (
        <Pressable style={styles.answer} onPress={onOpen}>
          <AppIcon uri={a.iconUrl ?? undefined} size={52} />
          <View style={{ flex: 1 }}>
            <Text style={styles.answerName}>{a.name}</Text>
            {!!a.subtitle && (
              <Text style={styles.answerSub} numberOfLines={2}>
                {a.subtitle}
              </Text>
            )}
            <Text style={styles.answerLink}>Open in Scout →</Text>
          </View>
        </Pressable>
      )}
      <Text style={styles.stats}>
        +{g.points} pts · {streakLabel(today.streak)} · week {today.week.score} pts
        {today.week.rank ? ` (#${today.week.rank})` : ''}
      </Text>
      <Pressable style={[styles.btn, shared && styles.btnDim]} onPress={onShare} disabled={shared}>
        <Text style={styles.btnText}>{shared ? 'Shared ✓' : 'Share to the Lounge'}</Text>
      </Pressable>
      {!today.hol.done && (
        <Pressable style={styles.btnGhost} onPress={onHol}>
          <Text style={styles.btnGhostText}>Play Higher or Lower →</Text>
        </Pressable>
      )}
      <Text style={styles.next}>Next puzzle in {untilNext(today.nextAt)}</Text>
    </View>
  );
}

/** Shown to anyone without a Lounge seat: what it is, and how to get in. */
export function SeatGate({
  lounge,
  onClaim,
}: {
  lounge: ReturnType<typeof useLoungeToken>;
  onClaim: () => void;
}) {
  return (
    <View style={styles.gate}>
      <Text style={styles.gateTitle}>One seat, one run, a fair board</Text>
      <Text style={styles.gateBody}>
        Scout Daily is for verified Seeker owners. Each Seeker gets one Lounge
        seat, and each seat gets one run a day at the same puzzle as everyone
        else. That's what keeps the leaderboard fair.
      </Text>
      {lounge.needsClaim ? (
        <Pressable style={styles.btn} onPress={onClaim}>
          <Text style={styles.btnText}>Claim your Lounge number</Text>
        </Pressable>
      ) : (
        <Pressable
          style={[styles.btn, lounge.verifying && styles.btnDim]}
          onPress={lounge.verify}
          disabled={lounge.verifying}
        >
          {lounge.verifying ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Text style={styles.btnText}>Verify my seat to play</Text>
          )}
        </Pressable>
      )}
      {!!lounge.error && <Text style={styles.err}>{lounge.error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 16, paddingBottom: 40 },
  no: { color: colors.purple, fontFamily: fonts.heavy, fontSize: 15 },
  intro: { color: colors.textDim, fontSize: 13, lineHeight: 19, marginBottom: 14 },
  board: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  clue: {
    width: '48.5%', minHeight: 74, backgroundColor: colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: colors.purple, padding: 10,
  },
  clueLocked: { borderColor: colors.border, justifyContent: 'center', alignItems: 'center' },
  clueLabel: { color: colors.purple, fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  clueValue: { color: colors.text, fontSize: 14, fontFamily: fonts.semi, marginTop: 4 },
  clueIcon: { width: 44, height: 44, borderRadius: 10, marginTop: 4 },
  lockedText: { color: colors.textDim, fontSize: 11 },
  gRow: {
    backgroundColor: colors.card, borderRadius: 12, padding: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  gRowRight: { borderColor: colors.green },
  gHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  gName: { color: colors.text, fontSize: 14, fontFamily: fonts.semi, flex: 1 },
  gMark: { fontSize: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: {
    backgroundColor: colors.cardNested, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 4, maxWidth: '100%',
  },
  chipOk: { backgroundColor: 'rgba(20,241,149,0.15)' },
  chipText: { color: colors.textDim, fontSize: 11, fontWeight: '700' },
  chipTextOk: { color: colors.green },
  legend: { color: colors.textDim, fontSize: 11, marginTop: 2 },
  inputWrap: { marginTop: 18 },
  left: { color: colors.textDim, fontSize: 12, fontWeight: '700', marginBottom: 6 },
  input: {
    backgroundColor: colors.card, color: colors.text, borderWidth: 1,
    borderColor: colors.purple, borderRadius: 12, paddingHorizontal: 14,
    paddingVertical: 12, fontSize: 15,
  },
  sugg: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8,
    paddingHorizontal: 6, borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  suggName: { color: colors.text, fontSize: 14, flex: 1 },
  result: {
    marginTop: 18, backgroundColor: colors.card, borderRadius: 16, padding: 16,
    borderWidth: 1, borderColor: colors.purple,
  },
  resultTitle: { color: colors.text, fontSize: 20, fontFamily: fonts.heavy },
  answer: { flexDirection: 'row', gap: 12, alignItems: 'center', marginTop: 14 },
  answerName: { color: colors.text, fontSize: 16, fontFamily: fonts.semi },
  answerSub: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  answerLink: { color: colors.green, fontSize: 12, fontWeight: '800', marginTop: 4 },
  stats: { color: colors.textDim, fontSize: 12, marginTop: 14 },
  btn: {
    backgroundColor: colors.purple, borderRadius: 12, marginTop: 14,
    paddingVertical: 13, alignItems: 'center', justifyContent: 'center', minHeight: 46,
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
  gate: {
    backgroundColor: colors.card, borderRadius: 16, padding: 18, marginTop: 8,
    borderWidth: 1, borderColor: colors.purple,
  },
  gateTitle: { color: colors.text, fontSize: 18, fontFamily: fonts.heavy },
  gateBody: { color: colors.textDim, fontSize: 13, lineHeight: 19, marginTop: 8 },
});
