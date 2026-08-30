import { json, type RequestHandler } from '@sveltejs/kit';
import { failIfNoId, failIfNoUser } from '$lib/utils/api-utils';

function pbDate(d: Date): string {
	return d.toISOString().replace('T', ' ');
}

// GET /api/monitors/:id/series?range=week|month&zone=all|<zone>
// Rollup-averaged response-time points for the longer chart ranges (which have
// no per-check phase data). week -> hourly rollups (7d), month -> day rollups (30d).
export const GET: RequestHandler = async ({ locals, params: { id }, url }) => {
	failIfNoUser(locals);
	id = failIfNoId(id);

	const range = url.searchParams.get('range');
	const zone = url.searchParams.get('zone') || 'all';

	let period: string;
	let since: Date;
	const now = Date.now();
	if (range === 'week') {
		period = 'hour';
		since = new Date(now - 7 * 86_400_000);
	} else if (range === 'month') {
		period = 'day';
		since = new Date(now - 30 * 86_400_000);
	} else {
		return json({ error: 'Invalid range' }, { status: 400 });
	}

	// Ownership check.
	try {
		await locals.pb!.collection('monitors').getOne(id, { filter: `user="${locals.user?.id}"` });
	} catch {
		return json({ error: 'Monitor not found' }, { status: 404 });
	}

	let filter = `monitor="${id}" && period="${period}" && bucket_start >= "${pbDate(since)}"`;
	if (zone !== 'all') filter += ` && zone="${zone}"`;

	let rows: Array<{
		bucket_start: string;
		avg_ms: number;
		uptime_pct: number;
		check_count: number;
	}> = [];
	try {
		rows = (await locals.pb!.collection('rollups').getFullList({
			filter,
			fields: 'bucket_start,avg_ms,uptime_pct,check_count',
			sort: 'bucket_start'
		})) as unknown as typeof rows;
	} catch (err) {
		console.warn('series rollups fetch failed:', err);
	}

	// Combine zones sharing a bucket (count-weighted average).
	const byBucket = new Map<string, { sum: number; cnt: number; up: number }>();
	for (const r of rows) {
		const b = byBucket.get(r.bucket_start) ?? { sum: 0, cnt: 0, up: 0 };
		const c = r.check_count ?? 0;
		b.sum += (r.avg_ms ?? 0) * c;
		b.cnt += c;
		b.up += ((r.uptime_pct ?? 0) / 100) * c;
		byBucket.set(r.bucket_start, b);
	}

	const points = [...byBucket.entries()]
		.sort((a, b) => (a[0] < b[0] ? -1 : 1))
		.map(([bucket, b]) => ({
			checked_at: bucket,
			response_ms: b.cnt ? Math.round(b.sum / b.cnt) : 0,
			up: b.cnt ? (b.up / b.cnt) * 100 >= 50 : true
		}));

	return json({ points });
};
