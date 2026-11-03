import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getAccountPlan } from '#lib/server/plan.js';
import { statusPageLimitMessage } from '#lib/plans.js';
import { readStatusPageForm, saveStatusPage } from '#lib/server/status-pages.js';

// The owner's list of status pages and the form for a new one (#679).
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/signin');
	const pb = locals.pb!;
	const [pages, monitors, { plan }] = await Promise.all([
		pb.collection('status_pages').getFullList({
			filter: pb.filter('user = {:u}', { u: locals.user.id }),
			sort: 'title',
			fields: 'id,title,slug,monitors'
		}),
		pb.collection('monitors').getFullList({
			filter: pb.filter('user = {:u}', { u: locals.user.id }),
			sort: 'name',
			fields: 'id,name'
		}),
		getAccountPlan(pb, locals.user)
	]);
	return {
		pages: pages.map((p) => ({
			id: p.id,
			title: p.title as string,
			slug: p.slug as string,
			count: ((p.monitors as string[]) ?? []).length
		})),
		monitors: monitors.map((m) => ({ id: m.id, name: m.name as string })),
		// Infinity on a self-hosted install (#694); the page then shows no limit.
		limit: plan.statusPages,
		limited: Number.isFinite(plan.statusPages),
		planName: plan.name,
		footer: plan.statusPageFooter,
		// The same words the refusal uses, from plans.ts.
		limitMessage: statusPageLimitMessage(plan)
	};
};

export const actions: Actions = {
	async create({ locals, request }) {
		if (!locals.user) return fail(401, { message: 'You are not signed in.', errors: {} });
		const input = readStatusPageForm(await request.formData());
		try {
			const res = await saveStatusPage(locals.pb!, locals.user, input);
			if (!res.ok) return fail(res.status, { message: res.message, errors: res.errors, input });
		} catch (err) {
			console.error('status page: create failed', (err as Error)?.message);
			return fail(503, { message: 'Could not save the page. Try again.', errors: {}, input });
		}
		return { success: true, message: `Your page is live at /s/${input.slug}.` };
	}
};
