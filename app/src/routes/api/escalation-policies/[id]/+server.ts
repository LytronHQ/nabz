import { json, type RequestHandler } from '@sveltejs/kit';
import { failIfNoId, failIfNoUser } from '$lib/utils/api-utils';
import { sanitizeSteps } from '$lib/server/escalation';

export const PATCH: RequestHandler = async ({ locals, request, params: { id } }) => {
	failIfNoUser(locals);
	id = failIfNoId(id);
	const body = await request.json().catch(() => ({}));
	const name = (body?.name ?? '').toString().trim();
	if (!name) return json({ error: 'Name is required' }, { status: 400 });

	try {
		// updateRule (@request.auth.id = user) scopes this to the owner.
		const rec = await locals.pb!.collection('escalation_policies').update(id, {
			name,
			steps: sanitizeSteps(body?.steps)
		});
		return json(rec);
	} catch {
		return json({ error: 'Error updating escalation policy' }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ locals, params: { id } }) => {
	failIfNoUser(locals);
	id = failIfNoId(id);
	try {
		await locals.pb!.collection('escalation_policies').delete(id);
		return new Response(null, { status: 204 });
	} catch {
		return json({ error: 'Error deleting escalation policy' }, { status: 500 });
	}
};
