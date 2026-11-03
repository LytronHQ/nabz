import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { ADMIN_EMAILS } from '$app/env/private';
import { isAdminUser } from '#lib/server/admin.js';
import { serviceClient } from '#lib/server/service-pb.js';
import { listPlanRows, setPlanByEmail } from '#lib/server/admin-plans.js';
import { PRO_FOR_ACCOUNTS_CREATED_BEFORE } from '#lib/plans.js';

// Same gate as /admin/usage: anyone else gets a 404, so the page is not discoverable.
export const load: PageServerLoad = async ({ locals }) => {
	if (!isAdminUser(locals.user, ADMIN_EMAILS)) throw error(404, 'Not found');
	const pb = await serviceClient();
	return { rows: await listPlanRows(pb), launchCutoff: PRO_FOR_ACCOUNTS_CREATED_BEFORE };
};

export const actions: Actions = {
	async setPlan({ locals, request }) {
		if (!isAdminUser(locals.user, ADMIN_EMAILS)) throw error(404, 'Not found');
		const form = await request.formData();
		const email = String(form.get('email') ?? '');
		const plan = String(form.get('plan') ?? '');
		const note = String(form.get('note') ?? '');
		try {
			const res = await setPlanByEmail(await serviceClient(), email, plan as 'free' | 'pro', note);
			return res.ok
				? { success: true, message: res.message }
				: fail(400, { success: false, message: res.message, email });
		} catch (err) {
			console.error('admin: setting a plan failed', (err as Error)?.message);
			return fail(503, { success: false, message: 'Could not save the plan. Try again.', email });
		}
	}
};
