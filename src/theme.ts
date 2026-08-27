/**
 * v0.2 design tokens (docs/BATTLE_PLAN_V02.md §4): near-black surface scale
 * with hairline borders — the "premium dark" vocabulary — plus Inter for the
 * bold-editorial headings. Green accent stays: it's our differentiation from
 * Solana-purple competitors.
 */
import { FRESH_ACTIVE_DAYS, FRESH_STALE_DAYS } from './lib/collections';

export const colors = {
  bg: '#0B0B0F', // surface base
  card: '#15151A', // raised (+4% white)
  cardNested: '#1F1F26', // nested (+8%)
  overlay: '#2A2A32', // overlay (+12%)
  border: 'rgba(255,255,255,0.09)', // hairline
  text: '#F5F5F7',
  textDim: '#9A9AA5',
  green: '#14F195', // Solana green
  purple: '#9945FF', // Solana purple
  yellow: '#F5C518',
  red: '#FF5C5C',
};

export const fonts = {
  heavy: 'Inter_800ExtraBold',
  semi: 'Inter_600SemiBold',
  regular: 'Inter_400Regular',
};

/** Shared editorial heading — screens spread this into their h1 styles. */
export const heading = {
  color: colors.text,
  fontSize: 28,
  fontFamily: fonts.heavy,
  letterSpacing: -0.5,
} as const;

/**
 * Freshness badge from a release date. Thresholds come from lib/collections so
 * this badge and Discover's "hide stale" filter are driven by one definition.
 */
export function freshness(lastUpdated: string): {
  label: string;
  color: string;
} {
  const days = (Date.now() - Date.parse(lastUpdated ?? '')) / 86_400_000;
  // An unparseable date used to fall through every comparison and land on
  // "Stale" — painting a red warning about an app we simply have no date for,
  // and disagreeing with isStale(), which treats unknown as not-stale.
  if (Number.isNaN(days)) return { label: 'Unknown', color: colors.textDim };
  if (days <= FRESH_ACTIVE_DAYS) return { label: 'Active', color: colors.green };
  if (days <= FRESH_STALE_DAYS) return { label: 'Aging', color: colors.yellow };
  return { label: 'Stale', color: colors.red };
}
