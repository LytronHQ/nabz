import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { MonitorItem } from '$lib/models/monitor';
import { loadMonitorFormOptions } from '$lib/server/monitor-form';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) {
		throw redirect(303, '/signin');
	}

	let record;
	try {
		record = await locals.pb!.collection('monitors').getOne(params.id, {
			filter: `user="${locals.user.id}"`
		});
	} catch {
		throw error(404, 'Monitor not found');
	}

	const options = await loadMonitorFormOptions(locals.pb!, locals.user.id);
	return { monitor: { ...new MonitorItem(record) }, ...options };
};
