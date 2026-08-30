import { json, type RequestHandler } from '@sveltejs/kit';
import { failIfNoId, failIfNoUser } from '$lib/utils/api-utils';

// POST /api/incidents/:id/action  { action: "acknowledge" | "escalate" }
// Records an acknowledgement or escalation on an incident (owner only) and adds a
// timeline event.
export const POST: RequestHandler = async ({ locals, params: { id }, request }) => {
	failIfNoUser(locals);
	id = failIfNoId(id);

	let action = '';
	try {
		const body = await request.json();
		action = (body?.action ?? '').toString();
	} catch {
		action = '';
	}
	if (action !== 'acknowledge' && action !== 'escalate') {
		return json({ error: 'Invalid action' }, { status: 400 });
	}

	// Ownership: the incident's monitor must belong to the user.
	let inc;
	try {
		inc = await locals.pb!.collection('incidents').getOne(id, { expand: 'monitor' });
	} catch {
		return json({ error: 'Incident not found' }, { status: 404 });
	}
	if (inc.expand?.monitor?.user !== locals.user?.id) {
		return json({ error: 'Incident not found' }, { status: 404 });
	}

	const who = locals.user?.name || locals.user?.email || 'A user';
	const nowIso = new Date().toISOString();

	try {
		if (action === 'acknowledge') {
			if (inc.acknowledged_at) {
				return json({ error: 'Already acknowledged' }, { status: 409 });
			}
			await locals.pb!.collection('incidents').update(id, {
				acknowledged_at: nowIso,
				acknowledged_by: who
			});
			await locals.pb!.collection('incident_events').create({
				incident: id,
				type: 'acknowledged',
				message: `Acknowledged by ${who}`,
				zone: '',
				author: who
			});
		} else {
			// escalate_now tells the evaluator to fire the next level immediately.
			await locals
				.pb!.collection('incidents')
				.update(id, { escalated_at: nowIso, escalate_now: true });
			await locals.pb!.collection('incident_events').create({
				incident: id,
				type: 'escalated',
				message: `Escalated by ${who}`,
				zone: '',
				author: who
			});
		}
	} catch (err) {
		console.warn('incident action failed:', err);
		return json({ error: 'Action failed' }, { status: 500 });
	}

	return json({
		ok: true,
		acknowledged_at: action === 'acknowledge' ? nowIso : inc.acknowledged_at || null,
		acknowledged_by: action === 'acknowledge' ? who : inc.acknowledged_by || '',
		escalated_at: action === 'escalate' ? nowIso : inc.escalated_at || null
	});
};
