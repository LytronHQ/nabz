import type { RequestHandler } from '@sveltejs/kit';
import {
	AlertChannelItem,
	AlertChannelItemValidator,
	toChannelConfig
} from '#lib/models/alert-channel.js';
import { failIfNoId, failIfNoResponse, failIfNoUser } from '#lib/utils/api-utils.js';
import { getApiErrors } from '#lib/utils/action-utils.js';
import { getAccountPlan, planRefusal } from '#lib/server/plan.js';
import { channelTypeAllowed, channelTypeMessage } from '#lib/plans.js';

export const PATCH: RequestHandler = async ({ locals, request, params: { id } }) => {
	failIfNoUser(locals);
	id = failIfNoId(id);

	try {
		const data = new AlertChannelItem(await request.formData());
		const validation = new AlertChannelItemValidator(data);
		if (!validation.isValid) {
			return validation.getInvalidDataResponse();
		}

		// A channel keeps the type it has (#678); switching it to a type the plan
		// does not include counts as adding one.
		const [{ plan }, current] = await Promise.all([
			getAccountPlan(locals.pb!, locals.user!),
			locals.pb!.collection('alert_channels').getOne(id, { fields: 'id,type' })
		]);
		if (!channelTypeAllowed(plan, data.type, String(current.type))) {
			return planRefusal(channelTypeMessage(plan, data.type), 'type');
		}

		const response = await locals.pb?.collection('alert_channels').update(id, {
			type: data.type,
			name: data.name,
			config: toChannelConfig(data),
			enabled: data.enabled
		});

		const item = failIfNoResponse(response);
		return Response.json(new AlertChannelItem(item));
	} catch (err) {
		return Response.json(getApiErrors(err, `Error updating alert channel: ${id}`), { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ locals, params: { id } }) => {
	failIfNoUser(locals);
	id = failIfNoId(id);

	try {
		await locals.pb?.collection('alert_channels').delete(id);
		return new Response(null, { status: 204 });
	} catch (err) {
		return Response.json(getApiErrors(err, `Error deleting alert channel: ${id}`), { status: 500 });
	}
};
