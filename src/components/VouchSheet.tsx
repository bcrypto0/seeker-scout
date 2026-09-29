import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { fetchRemoteFlags } from '../lib/catalog';
import { getSession, setSession, useWalletSession } from '../lib/session';
import type { DappEntry } from '../lib/types';
import {
  busyRetryLabel,
  getCachedResult,
  getLatestResult,
  MAX_NOTE,
  notePreview,
  PAUSED_SENTENCE,
  submitVouch,
  VOUCH_TAGS,
  vouchErrorCode,
  vouchDoneCopy,
  vouchErrorStatus,
  walletErrorSentence,
  weightLine,
} from '../lib/vouch';
import type { VouchResult, VouchTag, VouchVerdict } from '../lib/vouch';
import { connectWallet, findGenesisToken } from '../lib/wallet';
import { colors, fonts } from '../theme';
import { AppIcon } from './AppIcon';

type Busy = '' | 'connect' | 'check' | 'prep' | 'sign' | 'send' | 'wait';

const BUSY_LABEL: Record<Exclude<Busy, '' | 'wait'>, string> = {
  connect: 'Connecting wallet…',
  check: 'Checking Genesis Token…',
  prep: 'Checking the vouch service…',
  sign: 'Waiting for Seed Vault…',
  send: 'Recording your vouch…',
};

/** A vouch in flight: the sheet may close meanwhile, and shows this stage again when reopened. */
const SUBMIT_BUSY: ReadonlySet<Busy> = new Set<Busy>(['prep', 'sign', 'send', 'wait']);

/** Errors that mean the connected wallet is the wrong one, so offer to connect another. */
const WRONG_WALLET = new Set(['wallet does not hold this token', 'not a Seeker Genesis Token']);

/**
 * The vouch form: verdict, optional tags, optional one-line note, and at most
 * ONE Seed Vault prompt. No sheet primitive exists in the app, so this is a
 * react-native Modal with a bottom panel styled like the Alpha gate.
 *
 * Gating uses the app's existing verify flow (connectWallet, then
 * findGenesisToken, the same calls Profile and the Lounge make) and the
 * shared session, so someone who already connected elsewhere goes straight
 * to the form. The Genesis Token is the gate; a Lounge number is not needed,
 * it only labels the voice.
 *
 * The sheet can always be closed. A vouch in flight keeps going when it is:
 * its answer still reaches the card (onVouched), and reopening the sheet
 * shows the stage it is at instead of an idle form.
 */
export function VouchSheet({
  app,
  open,
  onClose,
  onVouched,
  onFailed,
}: {
  app: DappEntry;
  open: boolean;
  onClose: () => void;
  onVouched: (result: VouchResult) => void;
  /** A vouch that fails after the sheet was closed: the card shows the sentence instead. */
  onFailed?: (sentence: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useWalletSession();
  const [verdict, setVerdict] = useState<VouchVerdict | null>(null);
  const [tags, setTags] = useState<VouchTag[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<Busy>('');
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const [error, setError] = useState<string>();
  const [wrongWallet, setWrongWallet] = useState(false);
  const [done, setDone] = useState<VouchResult | null>(null);
  const [lastWeight, setLastWeight] = useState<VouchResult | null>(null);
  // Bumped on every open: a connect or Genesis check that finishes for an earlier opening only updates the session.
  const flowRef = useRef(0);
  const touchedRef = useRef(false);
  const submittingRef = useRef(false);
  const submitStage = useRef<{ busy: Busy; resumeAt: number | null }>({ busy: '', resumeAt: null });
  const doneRef = useRef<VouchResult | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!open) return;
    flowRef.current += 1;
    setError(undefined);
    setWrongWallet(false);
    setDone(null);
    doneRef.current = null;
    setLastWeight(null);
    setBusy(submitStage.current.busy);
    setResumeAt(submitStage.current.resumeAt);
    if (submittingRef.current) {
      touchedRef.current = true; // keep the form the vouch in flight was sent from
      return;
    }
    touchedRef.current = false;
    setVerdict(null);
    setTags([]);
    setNote('');
  }, [open]);

  // The busy countdown ticks once a second while a 503 'busy' waits for the server's minute to turn.
  useEffect(() => {
    if (!open || busy !== 'wait') return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [open, busy]);

  // Prefill from this device's last signed answer for this app (the worker serves no tags or note by mint).
  const mint = session?.mint;
  useEffect(() => {
    if (!open || !mint) return;
    const flow = flowRef.current;
    Promise.all([getCachedResult(mint, app.id), getLatestResult(mint)]).then(([here, latest]) => {
      if (flowRef.current !== flow) return;
      setLastWeight(latest);
      if (here && !touchedRef.current) {
        setVerdict(here.vouch.verdict);
        setTags(here.vouch.tags);
        setNote(here.vouch.note);
      }
    });
  }, [open, mint, app.id]);

  const inFlight = SUBMIT_BUSY.has(busy);

  async function checkGenesis(address: string, authToken: string, flow: number) {
    if (flowRef.current === flow) setBusy('check');
    const g = await findGenesisToken(address);
    // The session is shared, so it is updated even if this sheet was closed meanwhile.
    setSession({ address, authToken, mint: g.mint, genesis: g.status });
    if (flowRef.current !== flow) return;
    if (g.status === 'verified') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
  }

  async function onConnect() {
    if (busy) return;
    const flow = flowRef.current;
    setError(undefined);
    setWrongWallet(false);
    setBusy('connect');
    try {
      const conn = await connectWallet();
      await checkGenesis(conn.address, conn.authToken, flow);
    } catch (e) {
      console.warn('vouch sheet: wallet connect failed', e);
      if (flowRef.current === flow) setError(walletErrorSentence(e, 'connect'));
    } finally {
      if (flowRef.current === flow) setBusy('');
    }
  }

  async function onRetryCheck() {
    const s = getSession();
    if (!s || busy) return;
    const flow = flowRef.current;
    setError(undefined);
    try {
      await checkGenesis(s.address, s.authToken, flow);
    } finally {
      if (flowRef.current === flow) setBusy('');
    }
  }

  async function onSubmit() {
    const s = getSession();
    if (!s?.mint || !verdict || submittingRef.current) return;
    submittingRef.current = true;
    // Stage updates land whether or not the sheet is open; a reopen reads them back.
    const show = (b: Busy, at: number | null = null) => {
      submitStage.current = { busy: b, resumeAt: at };
      setBusy(b);
      setResumeAt(at);
    };
    setError(undefined);
    setWrongWallet(false);
    try {
      // The kill switch, read fresh, before any wallet prompt: a pause since the
      // card loaded must not cost a signature the worker would refuse.
      show('prep');
      const flags = await fetchRemoteFlags(true);
      if (!flags.vouch) {
        setError(PAUSED_SENTENCE);
        if (!openRef.current) onFailed?.(PAUSED_SENTENCE);
        return;
      }
      const result = await submitVouch(
        { address: s.address, authToken: s.authToken, mint: s.mint },
        { package: app.id, verdict, tags, note },
        (stage, info) =>
          show(stage === 'signing' ? 'sign' : stage === 'waiting' ? 'wait' : 'send', info?.resumeAt ?? null),
      );
      onVouched(result); // it landed: the card shows it whether or not this sheet is still open
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      const copy = vouchDoneCopy(result);
      AccessibilityInfo.announceForAccessibility(`${copy.title} ${copy.lines.join(' ')}`);
      doneRef.current = result;
      setDone(result);
      const hold = copy.lines.length > 1 || !copy.counts ? 2600 : 900;
      setTimeout(() => {
        if (doneRef.current === result && openRef.current) onClose();
      }, hold);
    } catch (e) {
      const status = vouchErrorStatus(e);
      if (status === undefined) console.warn('vouch sheet: wallet prompt failed', e);
      setWrongWallet(WRONG_WALLET.has(vouchErrorCode(e) ?? ''));
      // A VouchError's message is already the sentence; anything else came from the wallet.
      const sentence = status === undefined ? walletErrorSentence(e, 'sign') : String((e as Error).message);
      setError(sentence);
      // Closed while it was in flight: nobody sees this sheet, so the card says it instead.
      if (!openRef.current) onFailed?.(sentence);
    } finally {
      submittingRef.current = false;
      show('');
    }
  }

  const toggleTag = (id: VouchTag) => {
    touchedRef.current = true;
    Haptics.selectionAsync().catch(() => {});
    setTags((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  };
  const pickVerdict = (v: VouchVerdict) => {
    touchedRef.current = true;
    Haptics.selectionAsync().catch(() => {});
    setVerdict(v);
  };

  const phase: 'gate' | 'no-genesis' | 'net-error' | 'form' = !session
    ? 'gate'
    : session.mint
      ? 'form'
      : session.genesis === 'not-found'
        ? 'no-genesis'
        : 'net-error';
  const preview = phase === 'form' ? notePreview(note) : null;

  const busyButton = (label: string, onPress: () => void, disabled = false) => (
    <Pressable
      style={[styles.btn, disabled && styles.btnDisabled, !!busy && styles.btnDim]}
      onPress={onPress}
      disabled={disabled || !!busy}
    >
      {busy ? (
        <View style={styles.busyRow}>
          <ActivityIndicator color={colors.text} />
          <Text style={styles.btnText}>{busy === 'wait' ? busyRetryLabel(resumeAt) : BUSY_LABEL[busy]}</Text>
        </View>
      ) : (
        <Text style={[styles.btnText, disabled && { color: colors.textDim }]}>{label}</Text>
      )}
    </Pressable>
  );
  const ghost = (label: string, onPress: () => void) => (
    <Pressable style={styles.ghost} onPress={onPress} disabled={inFlight}>
      <Text style={styles.ghostText}>{label}</Text>
    </Pressable>
  );

  let body: React.ReactNode;
  if (done) {
    const copy = vouchDoneCopy(done);
    body = (
      <View style={styles.doneBox} accessibilityLiveRegion="polite">
        <Text style={[styles.doneTitle, !copy.counts && { color: colors.yellow }]}>{copy.title}</Text>
        {copy.lines.map((l) => (
          <Text key={l} style={styles.doneSub}>
            {l}
          </Text>
        ))}
      </View>
    );
  } else if (phase === 'gate') {
    body = (
      <>
        <Text style={styles.gateLabel}>VERIFIED SEEKER OWNERS ONLY</Text>
        <Text style={styles.gateBody}>
          Vouching is for people who own a Seeker. Connect your wallet and we check for the Genesis
          Token. Nothing is spent and no seed phrase is ever requested.
        </Text>
        {busyButton('Connect Wallet', onConnect)}
        {ghost('Not now', onClose)}
      </>
    );
  } else if (phase === 'no-genesis') {
    body = (
      <>
        <Text style={styles.gateLabel}>VERIFIED SEEKER OWNERS ONLY</Text>
        <Text style={styles.gateBody}>
          No Genesis Token in this wallet. Vouching is Seeker-owners only, so reviews stay read-only
          here.
        </Text>
        {busyButton('Connect another wallet', onConnect)}
        {ghost('Close', onClose)}
      </>
    );
  } else if (phase === 'net-error') {
    body = (
      <>
        <Text style={styles.gateLabel}>VERIFIED SEEKER OWNERS ONLY</Text>
        <Text style={styles.gateBody}>
          Couldn't reach the network to verify your Seeker. Try again.
        </Text>
        {busyButton('Retry', onRetryCheck)}
        {ghost('Close', onClose)}
      </>
    );
  } else {
    body = (
      <>
        <Text style={styles.section}>YOUR VERDICT</Text>
        <View style={styles.pills}>
          <Pressable
            style={[styles.pill, verdict === 'works' && styles.pillWorks]}
            onPress={() => pickVerdict('works')}
            disabled={inFlight}
            accessibilityState={{ selected: verdict === 'works' }}
          >
            <Text style={[styles.pillText, verdict === 'works' && styles.pillWorksText]}>
              Works on my Seeker
            </Text>
          </Pressable>
          <Pressable
            style={[styles.pill, verdict === 'broken' && styles.pillBroken]}
            onPress={() => pickVerdict('broken')}
            disabled={inFlight}
            accessibilityState={{ selected: verdict === 'broken' }}
          >
            <Text style={[styles.pillText, verdict === 'broken' && { color: colors.red }]}>
              Broken for me
            </Text>
          </Pressable>
        </View>

        <Text style={styles.section}>WHAT HAPPENED (OPTIONAL)</Text>
        <View style={styles.pills}>
          {VOUCH_TAGS.map((t) => {
            const on = tags.includes(t.id);
            return (
              <Pressable
                key={t.id}
                style={[styles.pill, on && styles.pillTag]}
                onPress={() => toggleTag(t.id)}
                disabled={inFlight}
                accessibilityState={{ selected: on }}
              >
                <Text style={[styles.pillText, on && { color: colors.purple }]}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.section}>NOTE (OPTIONAL)</Text>
        <TextInput
          style={styles.input}
          value={note}
          onChangeText={(t) => {
            touchedRef.current = true;
            setNote(t);
          }}
          maxLength={MAX_NOTE}
          placeholder="Optional: one line, no links (140 max)"
          placeholderTextColor={colors.textDim}
          accessibilityLabel="Note, optional, one line, no links"
          returnKeyType="done"
          editable={!inFlight}
        />
        <Text style={styles.counter}>
          {note.length}/{MAX_NOTE}
        </Text>
        {!!preview && <Text style={styles.preview}>{preview}</Text>}

        <Text style={styles.weight}>{weightLine(lastWeight)}</Text>

        {busyButton('Sign with Seed Vault', onSubmit, !verdict)}
        {wrongWallet && !busy && ghost('Connect another wallet', onConnect)}
        {/* Only before signing: once the wallet has signed, closing hides the sheet but the vouch still lands. */}
        {!busy && ghost('Cancel', onClose)}
        <Text style={styles.fine}>
          One Genesis Token, one voice per app. Vouches are public: a note shows with your verdict,
          tags and Lounge number if you have one, and anyone who knows your Genesis Token's address
          can see its verdicts. Your Seed Vault signs a short message; nothing is spent.
        </Text>
      </>
    );
  }

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        {/* Android: the Modal's content view already fits the system bars (RN ReactModalHostView,
            fitsSystemWindows), so the app window's bottom inset would be counted twice. */}
        <View style={[styles.panel, { paddingBottom: 18 + (Platform.OS === 'ios' ? insets.bottom : 0) }]}>
          <View style={styles.header}>
            <AppIcon uri={app.iconUrl} size={40} />
            <Text style={styles.title} numberOfLines={2}>
              Vouch for {app.name}
            </Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close">
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 4 }}>
            {body}
            {!!error && (
              <Text style={styles.err} accessibilityLiveRegion="polite">
                {error}
              </Text>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  // The Alpha gate card (AlphaScreen gate), anchored to the bottom.
  panel: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    padding: 18, maxHeight: '90%',
    borderWidth: 1, borderBottomWidth: 0, borderColor: colors.purple,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 6 },
  title: { flex: 1, color: colors.text, fontSize: 17, fontFamily: fonts.heavy },
  close: { color: colors.textDim, fontSize: 18, fontWeight: '700', paddingHorizontal: 4 },
  gateLabel: {
    color: colors.purple, fontSize: 11, fontWeight: '800', letterSpacing: 1.2, marginTop: 10,
  },
  gateBody: { color: colors.textDim, fontSize: 13, lineHeight: 19, marginTop: 10 },
  section: {
    color: colors.textDim, fontSize: 10, fontWeight: '800', letterSpacing: 0.8,
    marginTop: 16, marginBottom: 8,
  },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  // Discover's chip recipe.
  pill: {
    minHeight: 34, justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border, borderRadius: 999,
    paddingHorizontal: 12,
  },
  pillText: { color: colors.textDim, fontSize: 13, fontWeight: '700' },
  pillWorks: { backgroundColor: colors.green, borderColor: colors.green },
  pillWorksText: { color: '#00140B' },
  pillBroken: { borderColor: colors.red, backgroundColor: 'rgba(255,92,92,0.08)' },
  pillTag: { borderColor: colors.purple, backgroundColor: 'rgba(153,69,255,0.10)' },
  input: {
    backgroundColor: colors.cardNested, color: colors.text,
    borderWidth: 1, borderColor: colors.border, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14,
  },
  counter: {
    color: colors.textDim, fontSize: 11, marginTop: 4, textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  preview: { color: colors.yellow, fontSize: 12, lineHeight: 17, marginTop: 6 },
  weight: { color: colors.textDim, fontSize: 12, lineHeight: 17, marginTop: 14 },
  btn: {
    backgroundColor: colors.purple, borderRadius: 12, marginTop: 14,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center',
    minHeight: 48,
  },
  btnDim: { opacity: 0.6 },
  btnDisabled: {
    backgroundColor: colors.cardNested,
    borderWidth: 1, borderColor: colors.border,
  },
  btnText: { color: colors.text, fontWeight: '800', fontSize: 14 },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ghost: {
    marginTop: 10, paddingVertical: 10, borderRadius: 10,
    borderWidth: 1, borderColor: colors.border, alignItems: 'center',
  },
  ghostText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  fine: { color: colors.textDim, fontSize: 11, lineHeight: 16, marginTop: 12 },
  err: { color: colors.red, fontSize: 13, marginTop: 10, lineHeight: 18 },
  doneBox: { alignItems: 'center', paddingVertical: 22 },
  doneTitle: { color: colors.green, fontSize: 20, fontFamily: fonts.heavy },
  doneSub: { color: colors.textDim, fontSize: 13, lineHeight: 19, marginTop: 8, textAlign: 'center' },
});
