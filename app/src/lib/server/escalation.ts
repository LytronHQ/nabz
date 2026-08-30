// Normalize escalation policy steps from a request body: coerce delays to
// non-negative integers, keep only string channel ids, and sort by time.
export function sanitizeSteps(raw: any): { after_minutes: number; channels: string[] }[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((s) => ({
			after_minutes: Math.max(0, Math.floor(Number(s?.after_minutes) || 0)),
			channels: Array.isArray(s?.channels)
				? s.channels.filter((c: any) => typeof c === 'string')
				: []
		}))
		.sort((a, b) => a.after_minutes - b.after_minutes);
}
