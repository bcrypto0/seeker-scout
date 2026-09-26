import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
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
import * as Haptics from 'expo-haptics';
import { AppIcon } from '../components/AppIcon';
import { fetchCatalog } from '../lib/catalog';
import {
  ChatMessage,
  clearToken,
  fetchMessages,
  REACTIONS,
  reactToMessage,
  reportMessage,
  sendMessage,
} from '../lib/chat';
import { freshlyListed, scoutPick, topClimbers } from '../lib/collections';
import { isShare, parseShare } from '../lib/game';
import { DappEntry } from '../lib/types';
import { markSeen } from '../lib/unread';
import { useLoungeToken } from '../lib/useLounge';
import { colors, heading } from '../theme';

const POLL_MS = 5000;

/**
 * Conversation starters, shown while the box is empty. 17 of the Lounge's
 * first 40 messages were a bare "hi" or "gm" that went nowhere, and one new
 * member asked outright what the chat was for. Every thread that DID take
 * off was about specific apps, so these point there.
 */
const PROMPTS = [
  'What app are you using most this week?',
  'Recommend me a game 🎮',
  "Anyone tried today's Scout Pick?",
  'Which app should I finally delete?',
  'How did you do on Scout Daily?',
];

const tierTag = (m: ChatMessage) =>
  m.tier === 'founding' ? `🏆 #${m.number}` : m.tier === 'early' ? `⭐ #${m.number}` : `#${m.number}`;

/** Union by id (keeps optimistic sends the poll hasn't caught yet), drop
 *  locally-reported ids, sort ascending. Newer copies win, so reaction
 *  counts refresh on every poll. */
function mergeMessages(
  prev: ChatMessage[],
  next: ChatMessage[],
  hidden: Set<number>,
): ChatMessage[] {
  const byId = new Map<number, ChatMessage>();
  for (const m of prev) byId.set(m.id, m);
  for (const m of next) byId.set(m.id, m);
  return [...byId.values()]
    .filter((m) => !hidden.has(m.id))
    .sort((a, b) => a.id - b.id);
}

export function ChatScreen() {
  const nav = useNavigation<any>();
  const lounge = useLoungeToken();
  const token = lounge.token;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [catalog, setCatalog] = useState<DappEntry[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const hiddenRef = useRef<Set<number>>(new Set());
  const nearBottomRef = useRef(true);
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;

  const poll = useCallback(async () => {
    const msgs = await fetchMessages(0, tokenRef.current);
    setMessages((prev) => mergeMessages(prev, msgs, hiddenRef.current));
    // Reading the chat is what clears the Lounge tab's badge.
    const newest = msgs.length ? msgs[msgs.length - 1].id : 0;
    if (newest) markSeen(newest);
  }, []);

  useEffect(() => {
    poll();
    fetchCatalog().then(setCatalog);
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  // Re-read with the token once it arrives so "your" reactions light up.
  useEffect(() => {
    if (token) poll();
  }, [token, poll]);

  const radar = useMemo(() => {
    if (!catalog.length) return [];
    const out: { label: string; app: DappEntry }[] = [];
    const pick = scoutPick(catalog);
    if (pick) out.push({ label: 'Scout Pick', app: pick });
    const climb = topClimbers(catalog, 3).find((a) => a.id !== pick?.id);
    if (climb) out.push({ label: `Climbing ▲${climb.rankDelta}`, app: climb });
    const fresh = freshlyListed(catalog, 3).find((a) => !out.some((o) => o.app.id === a.id));
    if (fresh) out.push({ label: 'New in store', app: fresh });
    return out;
  }, [catalog]);

  async function onSend() {
    const t = text.trim();
    if (!t || !token || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const msg = await sendMessage(token, t);
      setText('');
      setMessages((m) => mergeMessages(m, [msg], hiddenRef.current));
      markSeen(msg.id);
      nearBottomRef.current = true; // sending implies you're at the bottom
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    } catch (e: any) {
      const m = e?.message ? String(e.message) : 'Send failed.';
      if (m.includes('authenticated')) await clearToken(); // token expired
      setError(m);
    } finally {
      setBusy(false);
    }
  }

  async function onReact(msg: ChatMessage, emoji: string) {
    setPickerFor(null);
    if (!token) {
      setError('Verify your seat to react.');
      return;
    }
    Haptics.selectionAsync().catch(() => {});
    // Optimistic: flip it locally now, then take the server's numbers.
    const had = (msg.mine ?? []).includes(emoji);
    const optimistic: ChatMessage = {
      ...msg,
      mine: had ? (msg.mine ?? []).filter((e) => e !== emoji) : [...(msg.mine ?? []), emoji],
      reactions: {
        ...(msg.reactions ?? {}),
        [emoji]: Math.max(0, ((msg.reactions ?? {})[emoji] ?? 0) + (had ? -1 : 1)),
      },
    };
    setMessages((m) => m.map((x) => (x.id === msg.id ? optimistic : x)));
    try {
      const res = await reactToMessage(token, msg.id, emoji);
      setMessages((m) =>
        m.map((x) => (x.id === msg.id ? { ...x, reactions: res.reactions, mine: res.mine } : x)),
      );
    } catch (e: any) {
      setMessages((m) => m.map((x) => (x.id === msg.id ? msg : x))); // roll back
      const em = e?.message ? String(e.message) : 'Reaction failed.';
      if (em.includes('authenticated')) await clearToken();
      setError(em);
    }
  }

  function onReport(msg: ChatMessage) {
    if (!token) return;
    Alert.alert('Report message', `Hide "#${msg.number}"'s message from the Lounge?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Report',
        style: 'destructive',
        onPress: () => {
          reportMessage(token, msg.id);
          hiddenRef.current.add(msg.id); // stay hidden across polls
          setMessages((m) => m.filter((x) => x.id !== msg.id));
        },
      },
    ]);
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => nav.goBack()} hitSlop={12}>
          <Text style={styles.back}>←</Text>
        </Pressable>
        <Text style={styles.h1}>The Lounge</Text>
        <Pressable onPress={() => nav.navigate('Guess')} hitSlop={12}>
          <Text style={styles.play}>🧭</Text>
        </Pressable>
      </View>

      {radar.length > 0 && (
        // A product card, deliberately not styled like a member: the Lounge
        // promises "no bots", and this is the app talking, not a person.
        <View style={styles.radar}>
          <Text style={styles.radarLabel}>📡 ON THE RADAR TODAY</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {radar.map((r) => (
              <Pressable
                key={r.app.id}
                style={styles.radarChip}
                onPress={() => nav.navigate('AppDetail', { app: r.app })}
              >
                <AppIcon uri={r.app.iconUrl} size={26} />
                <View>
                  <Text style={styles.radarKind}>{r.label}</Text>
                  <Text style={styles.radarName} numberOfLines={1}>
                    {r.app.name}
                  </Text>
                </View>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => String(m.id)}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        keyboardShouldPersistTaps="handled"
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          nearBottomRef.current =
            contentSize.height - (contentOffset.y + layoutMeasurement.height) < 120;
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          // Only auto-scroll if the user is already near the bottom: don't
          // yank someone reading history when a polled message arrives.
          if (nearBottomRef.current) listRef.current?.scrollToEnd({ animated: false });
        }}
        ListEmptyComponent={
          <Text style={styles.emptyChat}>
            No messages yet. Verified Seeker owners, say hello. 👋
          </Text>
        }
        renderItem={({ item }) => (
          <MessageBubble
            msg={item}
            pickerOpen={pickerFor === item.id}
            onPress={() => setPickerFor((p) => (p === item.id ? null : item.id))}
            onLongPress={() => onReport(item)}
            onReact={(e) => onReact(item, e)}
            onPlay={() => nav.navigate('Guess')}
          />
        )}
      />

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {!!error && <Text style={styles.err}>{error}</Text>}
        {token ? (
          <>
            {!text.trim() && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.prompts}
                keyboardShouldPersistTaps="handled"
              >
                {PROMPTS.map((p) => (
                  <Pressable key={p} style={styles.prompt} onPress={() => setText(p)}>
                    <Text style={styles.promptText}>{p}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                placeholder="Message the Lounge…"
                placeholderTextColor={colors.textDim}
                value={text}
                onChangeText={setText}
                maxLength={400}
                multiline
              />
              <Pressable
                style={[styles.send, (!text.trim() || busy) && styles.sendDim]}
                onPress={onSend}
                disabled={!text.trim() || busy}
              >
                {busy ? <ActivityIndicator color="#00140B" /> : <Text style={styles.sendText}>Send</Text>}
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Pressable
              style={[styles.authBtn, lounge.verifying && styles.sendDim]}
              onPress={lounge.needsClaim ? () => nav.navigate('Tabs', { screen: 'Lounge' }) : lounge.verify}
              disabled={lounge.verifying}
            >
              {lounge.verifying ? (
                <ActivityIndicator color={colors.text} />
              ) : (
                <Text style={styles.authText}>
                  {lounge.needsClaim ? 'Claim your Lounge number first' : 'Verify to join the chat'}
                </Text>
              )}
            </Pressable>
            {!!lounge.error && <Text style={styles.err}>{lounge.error}</Text>}
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function MessageBubble({
  msg,
  pickerOpen,
  onPress,
  onLongPress,
  onReact,
  onPlay,
}: {
  msg: ChatMessage;
  pickerOpen: boolean;
  onPress: () => void;
  onLongPress: () => void;
  onReact: (emoji: string) => void;
  onPlay: () => void;
}) {
  const counts = Object.entries(msg.reactions ?? {}).filter(([, n]) => n > 0);
  const mine = new Set(msg.mine ?? []);
  const share = isShare(msg.text) ? parseShare(msg.text) : null;
  return (
    <View style={{ alignSelf: 'flex-start', maxWidth: '90%' }}>
      <Pressable onPress={onPress} onLongPress={onLongPress} style={[styles.msg, share && styles.msgShare]}>
        <Text style={styles.msgTag}>{tierTag(msg)}</Text>
        {share ? (
          <>
            <Text style={styles.shareTitle}>{share.title}</Text>
            {share.lines.map((l, i) => (
              <Text key={i} style={styles.shareLine}>
                {l}
              </Text>
            ))}
            <Pressable onPress={onPlay} style={styles.sharePlay}>
              <Text style={styles.sharePlayText}>Play today's →</Text>
            </Pressable>
          </>
        ) : (
          <Text style={styles.msgText}>{msg.text}</Text>
        )}
      </Pressable>
      {counts.length > 0 && (
        <View style={styles.pills}>
          {counts.map(([e, n]) => (
            <Pressable
              key={e}
              onPress={() => onReact(e)}
              style={[styles.pill, mine.has(e) && styles.pillMine]}
            >
              <Text style={styles.pillText}>
                {e} {n}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {pickerOpen && (
        <View style={styles.picker}>
          {REACTIONS.map((e) => (
            <Pressable key={e} onPress={() => onReact(e)} hitSlop={6} style={styles.pickerBtn}>
              <Text style={styles.pickerEmoji}>{e}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  back: { color: colors.text, fontSize: 24, fontWeight: '700', width: 24 },
  play: { fontSize: 20, width: 24, textAlign: 'right' },
  h1: { ...heading, fontSize: 20 },
  radar: {
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  radarLabel: { color: colors.green, fontSize: 10, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
  radarChip: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.cardNested,
    borderRadius: 12, paddingVertical: 6, paddingHorizontal: 8, maxWidth: 200,
  },
  radarKind: { color: colors.textDim, fontSize: 10, fontWeight: '700' },
  radarName: { color: colors.text, fontSize: 13, fontWeight: '700', maxWidth: 140 },
  emptyChat: { color: colors.textDim, fontSize: 14, textAlign: 'center', marginTop: 60, paddingHorizontal: 30 },
  msg: {
    backgroundColor: colors.card, borderRadius: 14, padding: 12,
    borderWidth: 1, borderColor: colors.border,
  },
  msgShare: { borderColor: colors.purple },
  msgTag: { color: colors.purple, fontSize: 11, fontWeight: '800', marginBottom: 3 },
  msgText: { color: colors.text, fontSize: 14, lineHeight: 19 },
  shareTitle: { color: colors.text, fontSize: 15, fontWeight: '800', marginBottom: 4 },
  shareLine: { color: colors.text, fontSize: 14, lineHeight: 20 },
  sharePlay: {
    marginTop: 8, alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.purple,
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5,
  },
  sharePlayText: { color: colors.purple, fontSize: 12, fontWeight: '800' },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 5 },
  pill: {
    backgroundColor: colors.cardNested, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3,
    borderWidth: 1, borderColor: colors.border,
  },
  pillMine: { borderColor: colors.purple, backgroundColor: 'rgba(153,69,255,0.18)' },
  pillText: { color: colors.text, fontSize: 12 },
  picker: {
    flexDirection: 'row', gap: 4, marginTop: 6, backgroundColor: colors.overlay,
    borderRadius: 14, paddingHorizontal: 6, paddingVertical: 4, alignSelf: 'flex-start',
  },
  pickerBtn: { paddingHorizontal: 4, paddingVertical: 2 },
  pickerEmoji: { fontSize: 22 },
  err: { color: colors.red, fontSize: 12, paddingHorizontal: 16, marginBottom: 6 },
  prompts: { gap: 8, paddingHorizontal: 12, paddingTop: 6 },
  prompt: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 14,
    paddingHorizontal: 12, paddingVertical: 7, backgroundColor: colors.card,
  },
  promptText: { color: colors.textDim, fontSize: 12 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 12, paddingTop: 6 },
  input: {
    flex: 1, backgroundColor: colors.card, color: colors.text,
    borderWidth: 1, borderColor: colors.border, borderRadius: 14,
    paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, maxHeight: 120,
  },
  send: {
    backgroundColor: colors.green, borderRadius: 14,
    paddingHorizontal: 18, minHeight: 44, alignItems: 'center', justifyContent: 'center',
  },
  sendDim: { opacity: 0.5 },
  sendText: { color: '#00140B', fontWeight: '800', fontSize: 14 },
  authBtn: {
    backgroundColor: colors.purple, borderRadius: 14, margin: 12,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center', minHeight: 48,
  },
  authText: { color: colors.text, fontWeight: '800', fontSize: 14 },
});
