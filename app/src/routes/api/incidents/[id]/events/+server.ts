import type { RequestHandler } from '@sveltejs/kit';
import { failIfNoId, failIfNoUser } from '#lib/utils/api-utils.js';

// POST /api/incidents/:id/events  { message }
// Appends a user comment to an incident's timeline.
export const POST: RequestHandler = async ({ locals, params: { id }, request }) => {
	failIfNoUser(locals);
	id = failIfNoId(id);

	let message = '';
	try {
		const body = await request.json();
		message = (body?.message ?? '').toString().trim();
	} catch {
		message = '';
	}
	if (!message) return Response.json({ error: 'Message is required' }, { status: 400 });
	if (message.length > 2000) message = message.slice(0, 2000);

	// Ownership: the incident's monitor must belong to the user.
	try {
		const inc = await locals.pb!.collection('incidents').getOne(id, { expand: 'monitor' });
		if (inc.expand?.monitor?.user !== locals.user?.id) {
			return Response.json({ error: 'Incident not found' }, { status: 404 });
		}
	} catch {
		return Response.json({ error: 'Incident not found' }, { status: 404 });
	}

	const author = locals.user?.name || locals.user?.email || 'You';
	try {
		const rec = await locals.pb!.collection('incident_events').create({
			incident: id,
			type: 'comment',
			message,
			zone: '',
			author
		});
		return Response.json({ id: rec.id, type: 'comment', message, author, created: rec.created });
	} catch (err) {
		console.warn('post incident comment failed:', err);
		return Response.json({ error: 'Failed to post comment' }, { status: 500 });
	}
};
