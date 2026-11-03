import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { readStatusPageForm, saveStatusPage } from '#lib/server/status-pages.js';

// Edit or delete one status page (#679). The owner rule on status_pages makes
// another user's page a 404 here.
export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) throw redirect(303, '/signin');
	const pb = locals.pb!;
	let rec;
	try {
		rec = await pb.collection('status_pages').getOne(params.id);
	} catch {
		throw error(404, 'Status page not found');
	}
	const monitors = await pb.collection('monitors').getFullList({
		filter: pb.filter('user = {:u}', { u: locals.user.id }),
		sort: 'name',
		fields: 'id,name'
	});
	return {
		statusPage: {
			id: rec.id,
			title: rec.title as string,
			slug: rec.slug as string,
			description: (rec.description as string) ?? '',
			monitors: (rec.monitors as string[]) ?? []
		},
		monitors: monitors.map((m) => ({ id: m.id, name: m.name as string }))
	};
};

export const actions: Actions = {
	async update({ locals, request, params }) {
		if (!locals.user) return fail(401, { message: 'You are not signed in.', errors: {} });
		const input = readStatusPageForm(await request.formData());
		try {
			const res = await saveStatusPage(locals.pb!, locals.user, input, params.id);
			if (!res.ok) return fail(res.status, { message: res.message, errors: res.errors, input });
		} catch (err) {
			console.error('status page: update failed', (err as Error)?.message);
			return fail(503, { message: 'Could not save the page. Try again.', errors: {}, input });
		}
		return { success: true, message: 'Saved.' };
	},
	async delete({ locals, params }) {
		if (!locals.user) return fail(401, { message: 'You are not signed in.', errors: {} });
		try {
			await locals.pb!.collection('status_pages').delete(params.id);
		} catch (err) {
			console.error('status page: delete failed', (err as Error)?.message);
			return fail(503, { message: 'Could not delete the page. Try again.', errors: {} });
		}
		throw redirect(303, '/status-pages');
	}
};
