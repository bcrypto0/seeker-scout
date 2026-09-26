import { useCallback, useEffect, useState } from 'react';
import * as Haptics from 'expo-haptics';
import { authChat, cachedToken, onTokenChange } from './chat';
import { connectWallet, findGenesisToken } from './wallet';

/**
 * One Lounge sign-in shared by the chat, the Lounge hub and both games.
 * Verifying anywhere unlocks everything, because every screen listens for
 * token changes rather than keeping its own copy.
 *
 * `needsClaim` is true when the wallet holds a Genesis Token but hasn't
 * claimed a Lounge number yet: the worker refuses a token until it has, so
 * the UI should send the person to the claim card instead of showing a raw
 * server message.
 */
export function useLoungeToken() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string>();
  const [needsClaim, setNeedsClaim] = useState(false);

  useEffect(() => {
    let live = true;
    cachedToken().then((t) => {
      if (!live) return;
      setToken(t);
      setReady(true);
    });
    const off = onTokenChange((t) => live && setToken(t));
    return () => {
      live = false;
      off();
    };
  }, []);

  const verify = useCallback(async (): Promise<string | null> => {
    setError(undefined);
    setNeedsClaim(false);
    setVerifying(true);
    try {
      const conn = await connectWallet();
      const g = await findGenesisToken(conn.address);
      if (g.status !== 'verified' || !g.mint) {
        setError(
          g.status === 'not-found'
            ? 'Members only. There is no Seeker Genesis Token in this wallet.'
            : "Couldn't verify right now. Try again.",
        );
        return null;
      }
      const tok = await authChat(conn.address, conn.authToken, g.mint);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      return tok;
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : 'Sign-in cancelled.';
      if (/claim your founding number/i.test(msg)) {
        setNeedsClaim(true);
        setError('Claim your Lounge number first. It takes one tap on the Lounge tab.');
      } else {
        setError(msg);
      }
      return null;
    } finally {
      setVerifying(false);
    }
  }, []);

  return { token, ready, verifying, error, needsClaim, verify };
}
