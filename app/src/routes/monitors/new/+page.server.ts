import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { loadMonitorFormOptions } from '$lib/server/monitor-form';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(303, '/signin');
	}
	return loadMonitorFormOptions(locals.pb!, locals.user.id);
};
