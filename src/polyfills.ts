/**
 * Polyfills for @solana/web3.js on React Native.
 * Must be the FIRST import of the app (see index.ts) — import order is
 * hoisted, so these side effects need their own module to run early.
 */
import 'react-native-get-random-values';
import { Buffer } from 'buffer';

if (!global.Buffer) {
  global.Buffer = Buffer;
}
