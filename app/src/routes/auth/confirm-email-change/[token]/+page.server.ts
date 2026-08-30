import { type Actions, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { getActionFailure, getFormRecord } from '$lib/utils/action-utils';

export const load: PageServerLoad = async () => {
	return {};
};

const confirmSchema = z.object({
	password: z.string()
});

export const actions = {
	async default({ locals, request, params }) {
		const { token } = params;
		const formData = await getFormRecord(request, confirmSchema);
		if (!formData || !token) {
			return getActionFailure({ status: 400 }, 'Failed to change your email, please try again.');
		}

		try {
			await locals.pb?.collection('users').confirmEmailChange(token, formData.password);
		} catch (err: any) {
			switch (err.status) {
				case 400:
					return getActionFailure(err, 'Failed to change your email, please try again.');
				case 403:
					return getActionFailure(err, 'You are not allowed to perform this request.');
				default:
					return getActionFailure(
						err,
						'An error occurred while changing your email. Please try again later.'
					);
			}
		}

		// The email change invalidates the current session token — send them to sign
		// in again with the new address.
		locals.pb?.authStore.clear();
		throw redirect(303, '/signin');
	}
} satisfies Actions;
