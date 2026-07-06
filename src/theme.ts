export const colors = {
  bg: '#0E0E12',
  card: '#1A1A22',
  border: '#2A2A35',
  text: '#F2F2F7',
  textDim: '#9A9AA5',
  green: '#14F195', // Solana green
  purple: '#9945FF', // Solana purple
  yellow: '#F5C518',
  red: '#FF5C5C',
};

/** Freshness badge from a release date. */
export function freshness(lastUpdated: string): {
  label: string;
  color: string;
} {
  const days = (Date.now() - new Date(lastUpdated).getTime()) / 86_400_000;
  if (days <= 30) return { label: 'Active', color: colors.green };
  if (days <= 180) return { label: 'Aging', color: colors.yellow };
  return { label: 'Stale', color: colors.red };
}
