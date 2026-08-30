import { json, type RequestHandler } from '@sveltejs/kit';
import { failIfNoUser } from '$lib/utils/api-utils';

// POST /api/test-alert  { channel?: id }
// Queues a test-alert request; the evaluator delivers it to the given channel
// (or all of the user's channels when omitted) via the real alert path and
// records the result, which we poll for here.
export const POST: RequestHandler = async ({ locals, request }) => {
	failIfNoUser(locals);
	const userId = locals.user!.id;

	let channel = '';
	try {
		const body = await request.json();
		channel = (body?.channel ?? '').toString();
	} catch {
		channel = '';
	}

	let rec;
	try {
		rec = await locals
			.pb!.collection('test_alerts')
			.create({ user: userId, channel, status: 'pending' });
	} catch (err) {
		console.warn('create test alert failed:', err);
		return json({ error: 'Could not queue test alert' }, { status: 500 });
	}

	// The evaluator's loop runs ~every 10s; poll the record for its result.
	const deadline = Date.now() + 14000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 1200));
		try {
			const cur = await locals.pb!.collection('test_alerts').getOne(rec.id);
			if (cur.status === 'done') {
				const result = cur.result || 'Sent.';
				// "Notified N channel(s)" == fully delivered; anything else (failed /
				// partial / skipped) is not a clean success.
				const ok = /^Notified \d+ channel/.test(result);
				return json({ done: true, ok, result });
			}
		} catch {
			// transient — keep polling
		}
	}
	return json({ done: false, ok: false, result: 'Test queued — check your channel shortly.' });
};
