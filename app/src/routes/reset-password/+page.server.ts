import { type Actions, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { getActionFailure, getFormRecord } from '$lib/utils/action-utils';

const resetPasswordSchema = z.object({
	email: z.string()
});

export const actions = {
	async default({ locals, request }) {
		const formData = await getFormRecord(request, resetPasswordSchema);
		if (!formData) {
			return getActionFailure({ status: 400 }, 'Not a valid email address. Please try again.');
		}

		const { email } = formData;
		try {
			await locals.pb?.collection('users').requestPasswordReset(email);
		} catch (err: any) {
			return getActionFailure(
				err,
				'An error occurred while sending email for reset password. Please try again later.'
			);
		}

		throw redirect(303, '/reset-password/success-request');
	}
} satisfies Actions;
