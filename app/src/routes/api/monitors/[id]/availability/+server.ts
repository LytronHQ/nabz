import { json, type RequestHandler } from '@sveltejs/kit';
import { failIfNoId, failIfNoUser } from '$lib/utils/api-utils';
import { computeAvailability } from '$lib/server/availability';

// GET /api/monitors/:id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
// Availability + incident stats for a custom range (the From/To calculator).
export const GET: RequestHandler = async ({ locals, params: { id }, url }) => {
	failIfNoUser(locals);
	id = failIfNoId(id);

	const fromStr = url.searchParams.get('from');
	const toStr = url.searchParams.get('to');
	const from = fromStr ? new Date(fromStr) : null;
	// include the whole "to" day
	const to = toStr ? new Date(new Date(toStr).getTime() + 86_400_000) : new Date();

	if (!from || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
		return json({ error: 'Invalid from/to range' }, { status: 400 });
	}

	// Confirm the monitor belongs to the user before reporting on it.
	try {
		await locals.pb!.collection('monitors').getOne(id, { filter: `user="${locals.user?.id}"` });
	} catch {
		return json({ error: 'Monitor not found' }, { status: 404 });
	}

	const stat = await computeAvailability(locals.pb!, id, from, to);
	return json(stat);
};
