import { json, type RequestHandler } from '@sveltejs/kit';
import {
	AlertChannelItem,
	AlertChannelItemValidator,
	toChannelConfig
} from '$lib/models/alert-channel';
import { failIfNoId, failIfNoResponse, failIfNoUser } from '$lib/utils/api-utils';
import { getApiErrors } from '$lib/utils/action-utils';

export const PATCH: RequestHandler = async ({ locals, request, params: { id } }) => {
	failIfNoUser(locals);
	id = failIfNoId(id);

	try {
		const data = new AlertChannelItem(await request.formData());
		const validation = new AlertChannelItemValidator(data);
		if (!validation.isValid) {
			return validation.getInvalidDataResponse();
		}

		const response = await locals.pb?.collection('alert_channels').update(id, {
			type: data.type,
			name: data.name,
			config: toChannelConfig(data),
			enabled: data.enabled
		});

		const item = failIfNoResponse(response);
		return json(new AlertChannelItem(item));
	} catch (err) {
		return json(getApiErrors(err, `Error updating alert channel: ${id}`), { status: 500 });
	}
};

export const DELETE: RequestHandler = async ({ locals, params: { id } }) => {
	failIfNoUser(locals);
	id = failIfNoId(id);

	try {
		await locals.pb?.collection('alert_channels').delete(id);
		return new Response(null, { status: 204 });
	} catch (err) {
		return json(getApiErrors(err, `Error deleting alert channel: ${id}`), { status: 500 });
	}
};
