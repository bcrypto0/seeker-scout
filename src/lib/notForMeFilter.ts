/**
 * The "Not for me" list's pure half: which catalog apps Discover leaves out
 * and which ones its Hidden chip lists. notForMe.ts keeps the ids on the
 * device; this file only reads them.
 *
 * Where it applies: the Discover feed (All and the store categories), Top
 * climbers, the Scout pick and the owners' pick. Where it does not: Search
 * (a deliberate search finds every app and marks the hidden ones), the
 * Watching and To try views (an app on one of those lists stays there), and
 * the Lounge's "Most vouched this week" card (community data).
 *
 * No React Native import and no runtime import, so `npm run test:app` loads
 * it with Node's type stripping (src/lib/notForMeFilter.test.ts). The pick
 * functions come in as arguments for the same reason.
 */

/** The toggle on the app page and the mark on a hidden app's card. */
export const NOT_FOR_ME_LABEL = 'Not for me';

type HasId = { id: string };

/**
 * The apps not on the list, in their order. The same array when nothing is
 * hidden, so a memo that depends on it does not rerun for nothing.
 */
export function withoutHidden<T extends HasId>(apps: T[], hidden: ReadonlySet<string>): T[] {
  if (!hidden.size) return apps;
  return apps.filter((a) => !hidden.has(a?.id));
}

/**
 * The hidden apps the catalog lists, in catalog order: the Hidden chip's
 * list and its count. An id the catalog does not hold (a delisted app, or
 * the offline seed's 43 apps) is left out here but stays on the list.
 */
export function hiddenInCatalog<T extends HasId>(apps: T[], hidden: ReadonlySet<string>): T[] {
  if (!hidden.size) return [];
  return apps.filter((a) => !!a && hidden.has(a.id));
}

/**
 * A Discover pick (the Scout pick, the owners' pick) that is never a hidden
 * app. The pick is made over the whole catalog first, so hiding some other
 * app does not change it; only when that pick is hidden is it made again
 * over the apps left, and `pick`'s own fallbacks take it from there.
 * Undefined when nothing is left to pick from.
 */
export function visiblePick<T extends HasId>(
  apps: T[],
  hidden: ReadonlySet<string>,
  pick: (list: T[]) => T | undefined,
): T | undefined {
  const first = pick(apps);
  if (!first || !hidden.has(first.id)) return first;
  return pick(withoutHidden(apps, hidden));
}
