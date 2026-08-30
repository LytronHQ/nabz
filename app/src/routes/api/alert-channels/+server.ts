import { json, type RequestHandler } from '@sveltejs/kit';
import {
	AlertChannelItem,
	AlertChannelItemValidator,
	AlertChannelNewItem,
	toChannelConfig
} from '$lib/models/alert-channel';
import { failIfNoResponse, failIfNoUser } from '$lib/utils/api-utils';
import { DefaultPageSize } from '$lib/constants';
import { getApiErrors } from '$lib/utils/action-utils';

export const GET: RequestHandler = async ({ locals, url }) => {
	failIfNoUser(locals);

	const pageNumber = url.searchParams.get('page') ? Number(url.searchParams.get('page')) : 1;
	const perPage = url.searchParams.get('perPage')
		? Number(url.searchParams.get('perPage'))
		: DefaultPageSize;

	try {
		const response = await locals.pb?.collection('alert_channels').getList(pageNumber, perPage, {
			filter: `user="${locals.user?.id}"`,
			sort: '-created'
		});

		const result = failIfNoResponse(response);
		return json({ ...result, items: result.items.map((item: any) => new AlertChannelItem(item)) });
	} catch (err) {
		return json(getApiErrors(err, 'Error getting alert channels'), { status: 500 });
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	failIfNoUser(locals);

	const data = new AlertChannelNewItem(await request.formData());
	const validation = new AlertChannelItemValidator(data);
	if (!validation.isValid) {
		return validation.getInvalidDataResponse();
	}

	try {
		const response = await locals.pb?.collection('alert_channels').create({
			type: data.type,
			name: data.name,
			config: toChannelConfig(data),
			enabled: data.enabled,
			user: locals.user?.id
		});

		const item = failIfNoResponse(response);
		return json(new AlertChannelItem(item), { status: 201 });
	} catch (err) {
		return json(getApiErrors(err, 'Error creating alert channel'), { status: 500 });
	}
};
