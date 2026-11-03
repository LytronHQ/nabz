import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getPlanUsage } from '#lib/server/plan.js';

// The channel types the plan includes, so the Add form can mark the others (#678).
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/signin');
	return { plan: await getPlanUsage(locals.pb!, locals.user) };
};
