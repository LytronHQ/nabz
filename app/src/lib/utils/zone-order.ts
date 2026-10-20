/** A zone's presentation, as the monitor page needs it (#558). */
export type ZoneLabel = { label: string; sortOrder: number };

/** Zones in display order: the `zones` table's sort_order, then code — the same
 *  order the monitor form and the dashboard use.
 *
 *  The monitor page used to draw zones in whatever order `consensus_zones`
 *  held. The evaluator writes that list in the order each zone's oldest check
 *  turns up in its lookback window, which flips as old checks age out, so the
 *  By zone cards swapped places between loads. Ordering here makes the page
 *  independent of that. */
export function orderZones(codes: readonly string[], labels: Record<string, ZoneLabel>): string[] {
	const rank = (c: string) => labels[c]?.sortOrder ?? 1000;
	return [...codes].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** The name a user reads; the code when the zone has no label row. */
export function zoneName(code: string, labels: Record<string, ZoneLabel>): string {
	return labels[code]?.label || code;
}

/** Names the zones in text the evaluator wrote with codes (#560): an incident's
 *  cause and its "opened" timeline line end in "down in <code>, <code>". The
 *  stored text keeps the codes — they are the stable identifiers — so the
 *  naming happens where it is shown, as everywhere else in the app. */
export function nameZonesInText(text: string, labels: Record<string, ZoneLabel>): string {
	return text.replace(
		/(down in )([a-z0-9-]+(?:, [a-z0-9-]+)*)$/,
		(_, lead: string, list: string) =>
			lead +
			list
				.split(', ')
				.map((c) => zoneName(c, labels))
				.join(', ')
	);
}
