import type { ClientResponseError } from 'pocketbase';
import { type Actions, redirect } from '@sveltejs/kit';
import { jwtDecode } from 'jwt-decode';
import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { getActionFailure, getFormRecord } from '#lib/utils/action-utils.js';

type OutputType = {
	email: string | null;
};

const resetPasswordSchema = z.object({
	password: z.string(),
	confirmPassword: z.string()
});

// A mangled or truncated link (mail clients wrap long URLs) used to throw out of
// jwtDecode and answer 500 Internal Error. Decoding is only for showing the
// address; PocketBase still validates the token on submit.
export const load: PageServerLoad<OutputType> = async ({ params }) => {
	try {
		const { email } = jwtDecode<{ email?: unknown }>(params.token);
		return { email: typeof email === 'string' && email ? email : null };
	} catch {
		return { email: null };
	}
};

export const actions = {
	async default({ locals, request, params }) {
		const { token } = params;
		const formData = await getFormRecord(request, resetPasswordSchema);
		if (!formData || !token) {
			return getActionFailure({ status: 400 }, 'Failed to reset password, please try again.');
		}

		const { password, confirmPassword } = formData;
		try {
			await locals.pb?.collection('users').confirmPasswordReset(token, password, confirmPassword);
		} catch (err) {
			switch ((err as ClientResponseError).status) {
				case 400:
					return getActionFailure(err, 'Failed to reset password, please try again.');
				case 403:
					return getActionFailure(err, 'You are not allowed to perform this request.');
				default:
					return getActionFailure(
						err,
						'An error occurred while trying to reset password. Please try again later.'
					);
			}
		}

		throw redirect(303, '/reset-password/success');
	}
} satisfies Actions;
