import { randomBytes } from 'node:crypto';
import { json, type RequestHandler } from '@sveltejs/kit';
import type { ListResult, RecordModel } from 'pocketbase';
import {
	MonitorItem,
	MonitorItemValidator,
	MonitorNewItem,
	toMonitorConfig
} from '$lib/models/monitor';
import { failIfNoResponse, failIfNoUser } from '$lib/utils/api-utils';
import { DefaultPageSize } from '$lib/constants';
import { getApiErrors } from '$lib/utils/action-utils';
import { computeUptime24h } from '$lib/server/checks';
import { getLastDowntime } from '$lib/server/incidents';

export const GET: RequestHandler = async ({ locals, url }) => {
	failIfNoUser(locals);

	const pageNumber = url.searchParams.get('page') ? Number(url.searchParams.get('page')) : 1;
	const perPage = url.searchParams.get('perPage')
		? Number(url.searchParams.get('perPage'))
		: DefaultPageSize;
	const q = url.searchParams.get('q')?.trim();
	const tags = url.searchParams
		.getAll('tag')
		.map((t) => t.trim())
		.filter(Boolean);
	const status = url.searchParams.get('status')?.trim();

	// Server-side search/filter so it scales past the current page. pb.filter
	// interpolates params safely (no injection into the filter DSL).
	let expr = 'user = {:user}';
	const params: Record<string, unknown> = { user: locals.user?.id };
	if (q) {
		expr += ' && (name ~ {:q} || target ~ {:q} || tags ~ {:q})';
		params.q = q;
	}
	// Every #tag narrows the result further (AND), so a monitor must carry all of them.
	tags.forEach((tag, i) => {
		expr += ` && tags ~ {:tag${i}}`;
		params[`tag${i}`] = tag;
	});
	if (status === 'paused') {
		expr += ' && enabled = false';
	} else if (status) {
		expr += ' && enabled = true && status = {:status}';
		params.status = status;
	}

	try {
		const response = await locals.pb?.collection('monitors').getList(pageNumber, perPage, {
			filter: locals.pb!.filter(expr, params),
			sort: '-created'
		});

		const result = failIfNoResponse(response) as ListResult<RecordModel>;

		const items = await Promise.all(
			result.items.map(async (item) => {
				const [uptime24h, lastDowntime] = await Promise.all([
					computeUptime24h(locals.pb!, item.id),
					getLastDowntime(locals.pb!, item.id)
				]);
				return new MonitorItem({ ...item, uptime24h, lastDowntime });
			})
		);

		return json({ ...result, items });
	} catch (err) {
		return json(getApiErrors(err, 'Error getting monitors'), { status: 500 });
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	failIfNoUser(locals);

	const data = new MonitorNewItem(await request.formData());
	const dataValidation = new MonitorItemValidator(data);
	if (!dataValidation.isValid) {
		return dataValidation.getInvalidDataResponse();
	}

	try {
		// Heartbeat monitors are reached by the job checking in to /ping/{token},
		// so they carry an unguessable token instead of a probe target.
		const token = data.type === 'heartbeat' ? randomBytes(24).toString('base64url') : '';

		const response = await locals.pb?.collection('monitors').create({
			name: data.name,
			type: data.type,
			target: data.target,
			interval: data.interval,
			enabled: data.enabled,
			zones: data.zones,
			tags: data.tags,
			escalation_policy: data.escalationPolicy || null,
			config: toMonitorConfig(data),
			token,
			user: locals.user?.id
		});

		const item = failIfNoResponse(response);

		return json(new MonitorItem(item), { status: 201 });
	} catch (err) {
		return json(getApiErrors(err, 'Error creating monitor'), { status: 500 });
	}
};
