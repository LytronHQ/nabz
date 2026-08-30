import { json, type RequestHandler } from '@sveltejs/kit';
import { MonitorItem, MonitorItemValidator, toMonitorConfig } from '$lib/models/monitor';
import { failIfNoId, failIfNoResponse, failIfNoUser } from '$lib/utils/api-utils';
import { getApiErrors } from '$lib/utils/action-utils';

export const GET: RequestHandler = async ({ locals, params: { id } }) => {
	failIfNoUser(locals);
	id = failIfNoId(id);

	try {
		const response = await locals.pb?.collection('monitors').getOne(id, {
			filter: `user="${locals.user?.id}"`
		});

		const item = failIfNoResponse(response);

		return json(new MonitorItem(item));
	} catch (err) {
		return json(getApiErrors(err, `Error getting monitor: ${id}`));
	}
};

export const PATCH: RequestHandler = async ({ locals, request, params: { id } }) => {
	failIfNoUser(locals);
	id = failIfNoId(id);

	try {
		const data = new MonitorItem(await request.formData());
		const dataValidation = new MonitorItemValidator(data);
		if (!dataValidation.isValid) {
			return dataValidation.getInvalidDataResponse();
		}

		// Only the user-editable fields are written here; status / last_checked
		// are owned by the worker and evaluator.
		const response = await locals.pb?.collection('monitors').update(id, {
			name: data.name,
			type: data.type,
			target: data.target,
			interval: data.interval,
			enabled: data.enabled,
			zones: data.zones,
			tags: data.tags,
			escalation_policy: data.escalationPolicy || null,
			config: toMonitorConfig(data)
		});

		const item = failIfNoResponse(response);

		return json(new MonitorItem(item));
	} catch (err) {
		return json(getApiErrors(err, `Error updating monitor: ${id}`), { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ locals, params: { id } }) => {
	failIfNoUser(locals);
	id = failIfNoId(id);

	try {
		await locals.pb?.collection('monitors').delete(id, {
			user: locals.user?.id
		});

		return new Response(null, { status: 204 });
	} catch (err) {
		return json(getApiErrors(err, `Error deleting monitor: ${id}`), { status: 500 });
	}
};
