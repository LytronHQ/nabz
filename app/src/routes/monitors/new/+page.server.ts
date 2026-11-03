import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { loadMonitorFormOptions } from '#lib/server/monitor-form.js';
import { getPlanUsage } from '#lib/server/plan.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(303, '/signin');
	}
	const [options, plan] = await Promise.all([
		loadMonitorFormOptions(locals.pb!, locals.user.id),
		getPlanUsage(locals.pb!, locals.user)
	]);
	return { ...options, plan };
};
