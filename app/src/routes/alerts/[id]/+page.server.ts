import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { DefaultPageSize } from '$lib/constants';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	if (!locals.user) {
		throw redirect(303, '/signin');
	}

	let ch;
	try {
		ch = await locals.pb!.collection('alert_channels').getOne(params.id);
	} catch {
		throw error(404, 'Channel not found');
	}
	if (ch.user !== locals.user.id) {
		throw error(404, 'Channel not found');
	}

	const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
	const res = await locals
		.pb!.collection('channel_events')
		.getList(page, DefaultPageSize, {
			filter: `channel="${params.id}"`,
			sort: '-created',
			fields: 'id,kind,outcome,detail,created'
		})
		.catch(() => null);
	const events = res?.items ?? [];

	return {
		channel: {
			id: ch.id,
			type: ch.type as string,
			target: ch.target as string,
			enabled: !!ch.enabled
		},
		events: events.map((e) => ({
			id: e.id,
			kind: e.kind as string,
			outcome: e.outcome as string,
			detail: (e.detail as string) || '',
			created: e.created as string
		})),
		pagination: {
			current: res?.page ?? 1,
			size: res?.perPage ?? DefaultPageSize,
			totalItems: res?.totalItems ?? 0
		}
	};
};
