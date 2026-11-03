import type { RequestHandler } from '@sveltejs/kit';
import { MonitorItem, MonitorItemValidator, toMonitorConfig } from '#lib/models/monitor.js';
import { failIfNoId, failIfNoResponse, failIfNoUser } from '#lib/utils/api-utils.js';
import { getApiErrors } from '#lib/utils/action-utils.js';
import { getAccountPlan, planRefusal } from '#lib/server/plan.js';
import { intervalAllowed, intervalMessage } from '#lib/plans.js';

export const GET: RequestHandler = async ({ locals, params: { id } }) => {
	failIfNoUser(locals);
	id = failIfNoId(id);

	try {
		const response = await locals.pb?.collection('monitors').getOne(id, {
			filter: `user="${locals.user?.id}"`
		});

		const item = failIfNoResponse(response);

		return Response.json(new MonitorItem(item));
	} catch (err) {
		return Response.json(getApiErrors(err, `Error getting monitor: ${id}`));
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

		// Making a monitor check faster than the plan allows is refused (#678); an
		// interval it already had is kept, so older monitors stay editable.
		const [{ plan }, current] = await Promise.all([
			getAccountPlan(locals.pb!, locals.user!),
			locals.pb!.collection('monitors').getOne(id, { fields: 'id,interval' })
		]);
		if (!intervalAllowed(plan, data.interval, Number(current.interval))) {
			return planRefusal(intervalMessage(plan), 'interval');
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

		return Response.json(new MonitorItem(item));
	} catch (err) {
		return Response.json(getApiErrors(err, `Error updating monitor: ${id}`), { status: 500 });
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
		return Response.json(getApiErrors(err, `Error deleting monitor: ${id}`), { status: 500 });
	}
};
