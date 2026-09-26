import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackHeader } from '../components/BackHeader';
import { Board, getBoard, getToday, Today } from '../lib/game';
import { useLoungeToken } from '../lib/useLounge';
import { colors, fonts } from '../theme';

const badge = (tier: string, n: number) =>
  tier === 'founding' ? `🏆 #${n}` : tier === 'early' ? `⭐ #${n}` : `#${n}`;

/** "Sep 22": the week always starts on a Monday, UTC. */
const shortDate = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });

export function LeaderboardScreen() {
  const lounge = useLoungeToken();
  const [board, setBoard] = useState<Board | null>(null);
  const [me, setMe] = useState<Today | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      setBoard(await getBoard());
      if (lounge.token) setMe(await getToday(lounge.token).catch(() => null));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the board.");
    } finally {
      setLoading(false);
    }
  }, [lounge.token]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <BackHeader title="This week" />
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={colors.purple} />}
      >
        {loading ? (
          <ActivityIndicator color={colors.purple} style={{ marginTop: 40 }} />
        ) : !board ? (
          <Text style={styles.err}>{error ?? "Couldn't load the board."}</Text>
        ) : (
          <>
            <Text style={styles.sub}>
              Week of {shortDate(board.weekStart)} · {board.players}{' '}
              {board.players === 1 ? 'player' : 'players'} · resets Monday 00:00 UTC
            </Text>

            {me && (
              <View style={styles.me}>
                <Text style={styles.meLabel}>YOU</Text>
                <Text style={styles.meValue}>
                  {me.week.rank ? `#${me.week.rank}` : 'Unranked'} · {me.week.score} pts
                </Text>
                <Text style={styles.meSub}>{me.streak}-day streak</Text>
              </View>
            )}

            {board.top.length === 0 ? (
              <View style={styles.empty}>
                <Text style={styles.emptyIcon}>🧭</Text>
                <Text style={styles.emptyText}>
                  No scores yet this week. Play today's puzzles to take the top spot.
                </Text>
              </View>
            ) : (
              board.top.map((r) => (
                <View key={r.number} style={[styles.row, r.rank <= 3 && styles.rowTop]}>
                  <Text style={styles.rank}>{r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank}</Text>
                  <Text style={styles.who}>{badge(r.tier, r.number)}</Text>
                  <Text style={styles.days}>
                    {r.days} {r.days === 1 ? 'day' : 'days'}
                  </Text>
                  <Text style={styles.score}>{r.score}</Text>
                </View>
              ))
            )}

            <View style={styles.rules}>
              <Text style={styles.rulesTitle}>HOW POINTS WORK</Text>
              <Text style={styles.rulesText}>
                Guess the dApp: 10 for a first-try solve, then 8, 6, 5, 4, 3.{'\n'}
                Higher or Lower: 1 point for every 3 in a row, up to 10.{'\n'}
                Each game is worth up to 10 a day, so neither outweighs the other.
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 16, paddingBottom: 40 },
  sub: { color: colors.textDim, fontSize: 12, marginBottom: 14 },
  me: {
    backgroundColor: colors.card, borderRadius: 14, padding: 14, marginBottom: 14,
    borderWidth: 1, borderColor: colors.purple,
  },
  meLabel: { color: colors.purple, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  meValue: { color: colors.text, fontSize: 20, fontFamily: fonts.heavy, marginTop: 4 },
  meSub: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card,
    borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border,
  },
  rowTop: { borderColor: 'rgba(245,197,24,0.35)' },
  rank: { color: colors.textDim, fontSize: 16, fontFamily: fonts.heavy, width: 30, textAlign: 'center' },
  who: { color: colors.text, fontSize: 15, fontFamily: fonts.semi, flex: 1 },
  days: { color: colors.textDim, fontSize: 12 },
  score: { color: colors.green, fontSize: 17, fontFamily: fonts.heavy, minWidth: 36, textAlign: 'right', fontVariant: ['tabular-nums'] },
  empty: { alignItems: 'center', paddingVertical: 30 },
  emptyIcon: { fontSize: 34 },
  emptyText: { color: colors.textDim, fontSize: 14, textAlign: 'center', marginTop: 8, paddingHorizontal: 20 },
  rules: { marginTop: 18, backgroundColor: colors.cardNested, borderRadius: 12, padding: 14 },
  rulesTitle: { color: colors.textDim, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  rulesText: { color: colors.textDim, fontSize: 12, lineHeight: 19, marginTop: 6 },
  err: { color: colors.red, fontSize: 13, marginTop: 12 },
});
