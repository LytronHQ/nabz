import type { RequestHandler } from '@sveltejs/kit';
import { failIfNoId, failIfNoUser } from '#lib/utils/api-utils.js';
import { getApiErrors } from '#lib/utils/action-utils.js';

export const DELETE: RequestHandler = async ({ locals, params: { id } }) => {
	failIfNoUser(locals);
	id = failIfNoId(id);

	try {
		await locals.pb?.collection('dependencies').delete(id);
		return new Response(null, { status: 204 });
	} catch (err) {
		return Response.json(getApiErrors(err, `Error deleting dependency: ${id}`), { status: 500 });
	}
};
