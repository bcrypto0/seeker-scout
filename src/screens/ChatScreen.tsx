import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import {
  authChat,
  cachedToken,
  ChatMessage,
  fetchMessages,
  reportMessage,
  sendMessage,
} from '../lib/chat';
import { connectWallet, findGenesisToken } from '../lib/wallet';
import { colors, fonts, heading } from '../theme';

const POLL_MS = 5000;

const tierTag = (m: ChatMessage) =>
  m.tier === 'founding' ? `🏆 #${m.number}` : m.tier === 'early' ? `⭐ #${m.number}` : `#${m.number}`;

export function ChatScreen() {
  const nav = useNavigation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [authing, setAuthing] = useState(false);
  const [error, setError] = useState<string>();
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const lastId = useRef(0);

  const poll = useCallback(async () => {
    const msgs = await fetchMessages(0);
    if (msgs.length) {
      lastId.current = msgs[msgs.length - 1].id;
      setMessages(msgs);
    }
  }, []);

  useEffect(() => {
    cachedToken().then(setToken);
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  async function onAuth() {
    setError(undefined);
    setAuthing(true);
    try {
      const conn = await connectWallet();
      const g = await findGenesisToken(conn.address);
      if (g.status !== 'verified' || !g.mint) {
        setError(g.status === 'not-found' ? 'Members only — no Genesis Token in this wallet.' : "Couldn't verify — try again.");
        return;
      }
      const tok = await authChat(conn.address, conn.authToken, g.mint);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setToken(tok);
    } catch (e: any) {
      setError(e?.message ? String(e.message) : 'Sign-in cancelled.');
    } finally {
      setAuthing(false);
    }
  }

  async function onSend() {
    const t = text.trim();
    if (!t || !token || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const msg = await sendMessage(token, t);
      setText('');
      setMessages((m) => [...m, msg]);
      lastId.current = msg.id;
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    } catch (e: any) {
      const m = e?.message ? String(e.message) : 'Send failed.';
      if (m.includes('authenticated')) setToken(null); // token expired
      setError(m);
    } finally {
      setBusy(false);
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
        <View style={{ width: 24 }} />
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => String(m.id)}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <Text style={styles.emptyChat}>
            No messages yet — verified Seeker owners, say hello. 👋
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable onLongPress={() => onReport(item)} style={styles.msg}>
            <Text style={styles.msgTag}>{tierTag(item)}</Text>
            <Text style={styles.msgText}>{item.text}</Text>
          </Pressable>
        )}
      />

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {error && <Text style={styles.err}>{error}</Text>}
        {token ? (
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
            <Pressable style={[styles.send, (!text.trim() || busy) && styles.sendDim]} onPress={onSend} disabled={!text.trim() || busy}>
              {busy ? <ActivityIndicator color="#00140B" /> : <Text style={styles.sendText}>Send</Text>}
            </Pressable>
          </View>
        ) : (
          <Pressable style={[styles.authBtn, authing && styles.sendDim]} onPress={onAuth} disabled={authing}>
            {authing ? <ActivityIndicator color={colors.text} /> : <Text style={styles.authText}>Verify to join the chat</Text>}
          </Pressable>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
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
  h1: { ...heading, fontSize: 20 },
  emptyChat: { color: colors.textDim, fontSize: 14, textAlign: 'center', marginTop: 60, paddingHorizontal: 30 },
  msg: {
    backgroundColor: colors.card, borderRadius: 14, padding: 12,
    borderWidth: 1, borderColor: colors.border, alignSelf: 'flex-start', maxWidth: '90%',
  },
  msgTag: { color: colors.purple, fontSize: 11, fontWeight: '800', marginBottom: 3 },
  msgText: { color: colors.text, fontSize: 14, lineHeight: 19 },
  err: { color: colors.red, fontSize: 12, paddingHorizontal: 16, marginBottom: 6 },
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
