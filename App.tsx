import React, { useEffect, useState } from 'react';
import { AppState, Text } from 'react-native';
import {
  NavigationContainer,
  DarkTheme,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import {
  useFonts,
  Inter_400Regular,
  Inter_600SemiBold,
  Inter_800ExtraBold,
} from '@expo-google-fonts/inter';

// Show watchlist notifications even while the app is foregrounded (they only
// fire on open) — without this, expo-notifications suppresses them by default.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});
import { DiscoverScreen } from './src/screens/DiscoverScreen';
import { SearchScreen } from './src/screens/SearchScreen';
import { RewardsScreen } from './src/screens/RewardsScreen';
import { AlphaScreen } from './src/screens/AlphaScreen';
import { LoungeScreen } from './src/screens/LoungeScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { AppDetailScreen } from './src/screens/AppDetailScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { GuessScreen } from './src/screens/GuessScreen';
import { HigherLowerScreen } from './src/screens/HigherLowerScreen';
import { LeaderboardScreen } from './src/screens/LeaderboardScreen';
import { checkUnread, onUnreadChange } from './src/lib/unread';
import { checkReplies, onRepliesChange } from './src/lib/replies';
import { getMyNumber, onMyNumberChange, rememberMyNumber } from './src/lib/loungeNumber';
import { lastTokenClaim } from './src/lib/chat';
import { REPLY_ALERT_KIND } from './src/lib/notify';
import { syncReplyAlerts } from './src/lib/replyAlerts';
import { colors } from './src/theme';
import { pingOpen } from './src/lib/lounge';
import { bumpSession } from './src/lib/reviewPrompt';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();
const navRef = createNavigationContainerRef<any>();

/**
 * A tap on a reply alert opens the chat. A tap that cold-starts the app
 * arrives before navigation is ready, so it waits for onReady. Any other
 * notification (watchlist) just opens the app, as before.
 */
let chatPending = false;
function onNotificationTap(r: Notifications.NotificationResponse | null) {
  try {
    if (!r || r.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    if (r.notification.request.content.data?.kind !== REPLY_ALERT_KIND) return;
    // Handled once: a later launch must not reopen the chat for the same tap.
    Notifications.clearLastNotificationResponseAsync().catch(() => {});
    if (navRef.isReady()) navRef.navigate('Chat');
    else chatPending = true;
  } catch {
    /* the app still opens */
  }
}

const ICONS: Record<string, string> = {
  Discover: '✦',
  Search: '⌕',
  Rewards: '◈',
  Alpha: '◆',
  Lounge: '◇',
  Profile: '●',
};

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.card,
    border: colors.border,
    primary: colors.green,
    text: colors.text,
  },
};

// How often the Lounge badge re-checks while the app is in the foreground.
// The request returns two numbers, so this is cheap on data and on the worker.
const UNREAD_POLL_MS = 60_000;

/** The unread count, and the replies-to-you count (none without a Lounge number). */
function checkLounge() {
  checkUnread();
  checkReplies();
}

function Tabs() {
  const [unread, setUnread] = useState(0);
  const [replies, setReplies] = useState(0);

  useEffect(() => {
    const off = onUnreadChange(setUnread);
    const offReplies = onRepliesChange(setReplies);
    // Learning the number (a claim, a sign-in) starts the replies count at once.
    const offNumber = onMyNumberChange(() => checkReplies());
    checkLounge();
    let timer: ReturnType<typeof setInterval> | null = setInterval(checkLounge, UNREAD_POLL_MS);
    // Pause while backgrounded; re-check the moment the app comes back,
    // which is exactly when someone would want to see what they missed.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        checkLounge();
        if (!timer) timer = setInterval(checkLounge, UNREAD_POLL_MS);
      } else if (timer) {
        clearInterval(timer);
        timer = null;
      }
    });
    return () => {
      off();
      offReplies();
      offNumber();
      sub.remove();
      if (timer) clearInterval(timer);
    };
  }, []);

  // A reply to you turns the Lounge badge green (the Lounge tab says how
  // many); otherwise it is the purple unread count.
  const badgeCount = unread > 0 ? unread : replies;
  const replyBadge = replies > 0;

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.green,
        tabBarInactiveTintColor: colors.textDim,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
        tabBarIcon: ({ color }) => (
          <Text style={{ color, fontSize: 16 }}>{ICONS[route.name]}</Text>
        ),
      })}
    >
      <Tab.Screen name="Discover" component={DiscoverScreen} />
      <Tab.Screen name="Search" component={SearchScreen} />
      <Tab.Screen name="Rewards" component={RewardsScreen} />
      {/* 6 tabs as of v0.6 — the bar is at its practical limit on a Seeker;
          verify label truncation on hardware before shipping another one. */}
      <Tab.Screen name="Alpha" component={AlphaScreen} />
      <Tab.Screen
        name="Lounge"
        component={LoungeScreen}
        options={{
          tabBarBadge: badgeCount > 0 ? (badgeCount > 9 ? '9+' : badgeCount) : undefined,
          tabBarBadgeStyle: replyBadge
            ? { backgroundColor: colors.green, color: '#00140B', fontSize: 10 }
            : { backgroundColor: colors.purple, color: colors.text, fontSize: 10 },
        }}
      />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

export default function App() {
  // No render gate: Android silently falls back to the system font for
  // unknown families, and useFonts re-renders once Inter is ready — a brief
  // font swap beats blank frames on cold start (no splash-screen dep here).
  useFonts({
    Inter_400Regular,
    Inter_600SemiBold,
    Inter_800ExtraBold,
  });

  // Anonymous open ping — once per cold start, fire-and-forget (ad metric).
  // Dev-client sessions are excluded so testing never inflates the number.
  // bumpSession also gates the one-time review prompt (3rd cold start).
  useEffect(() => {
    if (!__DEV__) pingOpen();
    bumpSession();
  }, []);

  // Replies: fill the Lounge number from the last sign-in token if this
  // phone has none stored yet (installs from before replies), and make the
  // background task's registration match the Reply alerts switch.
  useEffect(() => {
    getMyNumber().then(async (n) => {
      if (n === null) await rememberMyNumber((await lastTokenClaim())?.number);
    });
    syncReplyAlerts();
  }, []);

  // A tap on a reply alert: the one that launched the app, then any later one.
  useEffect(() => {
    Notifications.getLastNotificationResponseAsync().then(onNotificationTap).catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener(onNotificationTap);
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <NavigationContainer
        theme={theme}
        ref={navRef}
        onReady={() => {
          if (chatPending) {
            chatPending = false;
            navRef.navigate('Chat');
          }
        }}
      >
        <StatusBar style="light" />
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Tabs" component={Tabs} />
          <Stack.Screen
            name="AppDetail"
            component={AppDetailScreen}
            options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
          />
          <Stack.Screen
            name="Chat"
            component={ChatScreen}
            options={{ animation: 'slide_from_right' }}
          />
          <Stack.Screen
            name="Guess"
            component={GuessScreen}
            options={{ animation: 'slide_from_right' }}
          />
          <Stack.Screen
            name="HigherLower"
            component={HigherLowerScreen}
            options={{ animation: 'slide_from_right' }}
          />
          <Stack.Screen
            name="Leaderboard"
            component={LeaderboardScreen}
            options={{ animation: 'slide_from_right' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
