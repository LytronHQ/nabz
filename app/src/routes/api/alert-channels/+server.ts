import type { RequestHandler } from '@sveltejs/kit';
import {
	AlertChannelItem,
	AlertChannelItemValidator,
	AlertChannelNewItem,
	toChannelConfig
} from '#lib/models/alert-channel.js';
import { failIfNoResponse, failIfNoUser } from '#lib/utils/api-utils.js';
import { DefaultPageSize } from '#lib/constants.js';
import { getApiErrors } from '#lib/utils/action-utils.js';
import { getAccountPlan, planRefusal } from '#lib/server/plan.js';
import { channelTypeAllowed, channelTypeMessage } from '#lib/plans.js';

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
		return Response.json({
			...result,
			items: result.items.map((item) => new AlertChannelItem(item))
		});
	} catch (err) {
		return Response.json(getApiErrors(err, 'Error getting alert channels'), { status: 500 });
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	failIfNoUser(locals);

	const data = new AlertChannelNewItem(await request.formData());
	const validation = new AlertChannelItemValidator(data);
	if (!validation.isValid) {
		return validation.getInvalidDataResponse();
	}

	const { plan } = await getAccountPlan(locals.pb!, locals.user!);
	if (!channelTypeAllowed(plan, data.type)) {
		return planRefusal(channelTypeMessage(plan, data.type), 'type');
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
		return Response.json(new AlertChannelItem(item), { status: 201 });
	} catch (err) {
		return Response.json(getApiErrors(err, 'Error creating alert channel'), { status: 500 });
	}
};
