/** The newest check per zone, for the monitor page's "By zone" cards (#406).
 *
 *  Chosen by comparing `checked_at`, deliberately, rather than by taking the
 *  first or last element of the list.
 *
 *  The previous version kept the first occurrence per zone, which is only the
 *  newest if the list happens to be newest-first. `fetchRecentChecks` returns it
 *  OLDEST-first — it sorts `-checked_at` so the row cap keeps the most recent,
 *  then reverses for the chart — so the cards showed the OLDEST check per zone:
 *  a monitor reading Up with every region reading Down, 0 ms and half an hour
 *  stale, long after those regions had recovered.
 *
 *  Comparing timestamps makes the result independent of the caller's ordering,
 *  which is the point: the bug existed because correctness was coupled to a sort
 *  order asserted in a comment in another file. */
export function latestPerZone<T extends { zone: string; checked_at: string }>(
	checks: readonly T[]
): Record<string, T> {
	const out: Record<string, T> = {};
	for (const c of checks) {
		if (!c?.zone) continue;
		const seen = out[c.zone];
		// PocketBase timestamps are fixed-width UTC strings, so lexical order is
		// chronological order — no Date parsing per row.
		if (!seen || c.checked_at > seen.checked_at) out[c.zone] = c;
	}
	return out;
}
