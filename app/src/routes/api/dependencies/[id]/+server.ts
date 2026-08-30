import { json, type RequestHandler } from '@sveltejs/kit';
import { failIfNoId, failIfNoUser } from '$lib/utils/api-utils';
import { getApiErrors } from '$lib/utils/action-utils';

export const DELETE: RequestHandler = async ({ locals, params: { id } }) => {
	failIfNoUser(locals);
	id = failIfNoId(id);

	try {
		await locals.pb?.collection('dependencies').delete(id);
		return new Response(null, { status: 204 });
	} catch (err) {
		return json(getApiErrors(err, `Error deleting dependency: ${id}`), { status: 500 });
	}
};
