import React, { useEffect, useState } from 'react';
import { AppState, Text } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
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
import { colors } from './src/theme';
import { pingOpen } from './src/lib/lounge';
import { bumpSession } from './src/lib/reviewPrompt';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

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

function Tabs() {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const off = onUnreadChange(setUnread);
    checkUnread();
    let timer: ReturnType<typeof setInterval> | null = setInterval(checkUnread, UNREAD_POLL_MS);
    // Pause while backgrounded; re-check the moment the app comes back,
    // which is exactly when someone would want to see what they missed.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        checkUnread();
        if (!timer) timer = setInterval(checkUnread, UNREAD_POLL_MS);
      } else if (timer) {
        clearInterval(timer);
        timer = null;
      }
    });
    return () => {
      off();
      sub.remove();
      if (timer) clearInterval(timer);
    };
  }, []);

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
          tabBarBadge: unread > 0 ? (unread > 9 ? '9+' : unread) : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.purple, color: colors.text, fontSize: 10 },
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

  return (
    <SafeAreaProvider>
      <NavigationContainer theme={theme}>
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
