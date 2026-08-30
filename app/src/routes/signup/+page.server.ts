import { type Actions } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { getActionFailure, getAuthCallbackData, getFormRecord } from '$lib/utils/action-utils';
import { migrateAnonMonitors } from '$lib/server/anon-migrate';
import { clearAnonCookie } from '$lib/server/anon';

export const load: PageServerLoad = async ({ locals, url }) => {
	return await getAuthCallbackData(locals, url);
};

const signupSchema = z.object({
	name: z.string().optional(),
	email: z.string(),
	password: z.string(),
	confirmPassword: z.string()
});

export const actions = {
	async default({ locals, request, cookies }) {
		const formData = await getFormRecord(request, signupSchema);
		if (!formData) {
			return getActionFailure({ status: 400 }, 'Failed to register, please try again.');
		}

		const { name, email, password, confirmPassword } = formData;
		try {
			const user = await locals.pb?.collection('users').create({
				email,
				emailVisibility: true,
				password,
				passwordConfirm: confirmPassword,
				name
			});

			await locals.pb?.collection('users').requestVerification(email);

			// Keep the monitor they just tried anonymously (#272). Best-effort — a
			// migration hiccup must never fail an otherwise-successful signup.
			if (locals.anonSession && user?.id) {
				await migrateAnonMonitors(locals.anonSession, user.id);
				clearAnonCookie(cookies);
			}

			return { success: true };
		} catch (err: any) {
			switch (err.status) {
				case 400:
					return getActionFailure(err, 'Failed to register, please try again.');
				case 403:
					return getActionFailure(err, 'You are not allowed to perform this request.');
				default:
					return getActionFailure(
						err,
						'An error occurred while trying to register the user. Please try again later.'
					);
			}
		}
	}
} satisfies Actions;
