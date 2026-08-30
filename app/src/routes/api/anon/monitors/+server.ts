import { json, type RequestHandler } from '@sveltejs/kit';
import { serviceClient } from '$lib/server/service-pb';
import {
	ANON_ALLOWED_TYPE,
	ANON_MAX_PER_IP_PER_HOUR,
	ANON_MAX_PER_SESSION,
	ANON_MIN_INTERVAL,
	hashIP,
	mintAnonToken,
	setAnonCookie,
	validateAnonTarget
} from '$lib/server/anon';

// Create one anonymous "try it" monitor (#269). No user session — the signed
// anon_session cookie is the identity. Writes go through the web service account
// (a signed-out visitor's client can't write PB); limits are enforced here:
// website-only, interval >= 5 min, <= 1 per session, and a per-IP hourly cap.
export const POST: RequestHandler = async ({ request, locals, cookies, getClientAddress }) => {
	let body: Record<string, unknown> = {};
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		body = {};
	}

	const target = String(body.target ?? '').trim();
	const check = validateAnonTarget(target);
	if (!check.ok) return json({ error: check.error }, { status: 400 });

	const name = String(body.name ?? '').trim() || new URL(target).hostname;
	let interval = Number(body.interval);
	if (!Number.isFinite(interval) || interval < ANON_MIN_INTERVAL) interval = ANON_MIN_INTERVAL;

	const token = locals.anonSession || mintAnonToken();
	const isNewSession = !locals.anonSession;
	const ipHash = hashIP(getClientAddress());

	let pb;
	try {
		pb = await serviceClient();
	} catch {
		return json({ error: 'The trial is temporarily unavailable.' }, { status: 503 });
	}

	try {
		// Per-session cap — only an existing session can already have one.
		if (!isNewSession) {
			const mine = await pb
				.collection('anon_monitors')
				.getList(1, 1, { filter: pb.filter('session = {:s}', { s: token }) });
			if (mine.totalItems >= ANON_MAX_PER_SESSION) {
				return json(
					{ error: 'You already have a trial monitor — sign up to add more.' },
					{ status: 409 }
				);
			}
		}

		// Per-IP rate limit — rows this IP created in the last hour (PB datetime
		// filter format is "YYYY-MM-DD HH:MM:SS.sssZ").
		const since = new Date(Date.now() - 3600_000).toISOString().replace('T', ' ');
		const recent = await pb.collection('anon_monitors').getList(1, 1, {
			filter: pb.filter('ip_hash = {:h} && created >= {:since}', { h: ipHash, since })
		});
		if (recent.totalItems >= ANON_MAX_PER_IP_PER_HOUR) {
			return json(
				{ error: 'Too many trial monitors from your network right now — try later, or sign up.' },
				{ status: 429 }
			);
		}

		const created = await pb.collection('anon_monitors').create({
			name,
			type: ANON_ALLOWED_TYPE,
			target,
			interval,
			status: 'pending',
			session: token,
			ip_hash: ipHash
		});

		if (isNewSession) setAnonCookie(cookies, token);
		return json({ id: created.id }, { status: 201 });
	} catch (err) {
		console.error('anon monitor create failed', err);
		return json({ error: 'Could not create the trial monitor.' }, { status: 500 });
	}
};
