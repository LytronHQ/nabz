import type { RequestHandler } from '@sveltejs/kit';
import { failIfNoUser } from '#lib/utils/api-utils.js';
import { sanitizeSteps } from '#lib/server/escalation.js';

export const GET: RequestHandler = async ({ locals }) => {
	failIfNoUser(locals);
	try {
		const items = await locals.pb!.collection('escalation_policies').getFullList({
			filter: `user="${locals.user!.id}"`,
			sort: 'name',
			fields: 'id,name,steps'
		});
		return Response.json({ items });
	} catch {
		return Response.json({ error: 'Error listing escalation policies' }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	failIfNoUser(locals);
	const body = await request.json().catch(() => ({}));
	const name = (body?.name ?? '').toString().trim();
	if (!name) return Response.json({ error: 'Name is required' }, { status: 400 });

	try {
		const rec = await locals.pb!.collection('escalation_policies').create({
			user: locals.user!.id,
			name,
			steps: sanitizeSteps(body?.steps)
		});
		return Response.json(rec, { status: 201 });
	} catch {
		return Response.json({ error: 'Error creating escalation policy' }, { status: 500 });
	}
};
