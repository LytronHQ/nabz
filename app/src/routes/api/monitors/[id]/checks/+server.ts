import { json, type RequestHandler } from '@sveltejs/kit';
import { failIfNoId, failIfNoUser } from '$lib/utils/api-utils';
import { getApiErrors } from '$lib/utils/action-utils';
import { fetchRecentChecks } from '$lib/server/checks';

export const GET: RequestHandler = async ({ locals, params: { id }, url }) => {
	failIfNoUser(locals);
	id = failIfNoId(id);

	const hours = Number(url.searchParams.get('hours')) || 24;

	try {
		const items = await fetchRecentChecks(locals.pb!, id, hours);
		return json({ items });
	} catch (err) {
		return json(getApiErrors(err, `Error getting checks for monitor: ${id}`), { status: 500 });
	}
};
