import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, Linking } from 'react-native';

/**
 * Engagement-gated review prompt.
 *
 * Our store rating is the bottleneck on the one distribution channel we own
 * (ranked discovery inside the dApp Store), and until now nothing in the app
 * ever asked for a review — the only ask was a banner in a carousel that
 * auto-advances every 4.5s.
 *
 * Rules, deliberately conservative:
 * - Only ask after a genuine positive signal: the 3rd cold start, or the
 *   first time the user stars an app (they liked something enough to track).
 * - Ask ONCE, ever. Any answer — yes, later, or a dismissed dialog — sets the
 *   asked flag permanently. Nagging is how you earn a 1-star.
 * - Never block: fire-and-forget, always resolves, never throws.
 */
const SESSIONS_KEY = 'seekerscout.sessions.v1';
const ASKED_KEY = 'seekerscout.reviewAsked.v1';
const MIN_SESSIONS = 3;
const LISTING_URL = 'solanadappstore://details?id=com.bilal.seekerscout';
const FEEDBACK_EMAIL = 'seekerscoutapp@gmail.com';

/** Count this cold start. Returns the new session count (1-based). */
export async function bumpSession(): Promise<number> {
  try {
    const n = Number((await AsyncStorage.getItem(SESSIONS_KEY)) ?? '0') + 1;
    await AsyncStorage.setItem(SESSIONS_KEY, String(n));
    return n;
  } catch {
    return 0;
  }
}

async function alreadyAsked(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(ASKED_KEY)) === '1';
  } catch {
    return true; // storage unavailable → err toward not nagging
  }
}

async function markAsked(): Promise<void> {
  try {
    await AsyncStorage.setItem(ASKED_KEY, '1');
  } catch {
    /* best-effort */
  }
}

/**
 * Show the one-time ask. Marks as asked BEFORE showing, so a crash, a
 * backgrounded app, or a swiped-away dialog can never produce a second prompt.
 */
async function prompt(body: string): Promise<void> {
  if (await alreadyAsked()) return;
  await markAsked();
  // Two-step, deliberately. Sending everyone straight to the store is how a
  // 3.6-star app gets to 3.2: the unhappy ones are the most motivated to
  // follow through. Ask sentiment FIRST; only happy users ever see the store
  // link, and unhappy ones get a route that reaches us instead of the rating.
  Alert.alert('Enjoying Seeker Scout?', body, [
    {
      text: 'Not really',
      style: 'cancel',
      onPress: () => {
        Alert.alert(
          'What would fix it?',
          "Tell me what's missing or broken and I'll actually build it — that's how the newest-first sort and the rewards list got made.",
          [
            { text: 'Never mind', style: 'cancel' },
            {
              text: 'Send feedback',
              onPress: () => {
                Linking.openURL(
                  `mailto:${FEEDBACK_EMAIL}?subject=Seeker%20Scout%20feedback`,
                ).catch(() => {});
              },
            },
          ],
        );
      },
    },
    {
      text: 'Yes!',
      onPress: () => {
        Alert.alert(
          'Mind rating it?',
          'A rating on the dApp Store is the single biggest thing that helps other Seeker owners find it.',
          [
            { text: 'Not now', style: 'cancel' },
            {
              text: 'Rate it',
              onPress: () => {
                Linking.openURL(LISTING_URL).catch(() => {});
              },
            },
          ],
        );
      },
    },
  ]);
}

/** Trigger A: user has opened the app enough times to have an opinion. */
export async function maybeAskAfterSessions(): Promise<void> {
  try {
    const n = Number((await AsyncStorage.getItem(SESSIONS_KEY)) ?? '0');
    if (n < MIN_SESSIONS) return;
    await prompt(
      'A rating on the dApp Store genuinely helps other Seeker owners find the app — and tells me what to build next.',
    );
  } catch {
    /* never let this break a screen */
  }
}

/**
 * Trigger B: user starred an app AND has been around a while. The session
 * floor matters — a first-run user starring their first app hasn't formed an
 * opinion yet, and we only ever get one ask.
 */
export async function maybeAskAfterFirstStar(): Promise<void> {
  try {
    const n = Number((await AsyncStorage.getItem(SESSIONS_KEY)) ?? '0');
    if (n < MIN_SESSIONS) return;
    await prompt(
      "You're tracking apps now — so you've given it a real go. Honest answer is genuinely useful either way.",
    );
  } catch {
    /* never let this break a screen */
  }
}
