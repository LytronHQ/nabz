import { type Actions, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { getActionFailure, getAuthCallbackData, getFormRecord } from '$lib/utils/action-utils';
import { migrateAnonMonitors } from '$lib/server/anon-migrate';
import { clearAnonCookie } from '$lib/server/anon';

export const load: PageServerLoad = async ({ locals, url }) => {
	return await getAuthCallbackData(locals, url);
};

const signinSchema = z.object({
	email: z.string(),
	password: z.string()
});

export const actions = {
	async default({ locals, request, cookies }) {
		const formData = await getFormRecord(request, signinSchema);
		if (!formData) {
			return getActionFailure({ status: 400 }, 'Invalid username or password.');
		}

		const { email, password } = formData;
		try {
			await locals.pb?.collection('users').authWithPassword(email, password);
		} catch (err: any) {
			switch (err.status) {
				case 400:
					return getActionFailure(err, 'Invalid username or password');
				case 403:
					return getActionFailure(
						err,
						err.response.message ?? 'Failed to login, please try again.'
					);
				default:
					return getActionFailure(
						err,
						'An error occurred while trying to authenticate the user. Please try again later.'
					);
			}
		}

		// Claim a monitor tried anonymously before this sign-in (#272), e.g. the
		// visitor signed up in another tab. Best-effort; never blocks the redirect.
		const userId = locals.pb?.authStore.record?.id;
		if (locals.anonSession && userId) {
			await migrateAnonMonitors(locals.anonSession, userId);
			clearAnonCookie(cookies);
		}

		throw redirect(303, '/dashboard');
	}
} satisfies Actions;
