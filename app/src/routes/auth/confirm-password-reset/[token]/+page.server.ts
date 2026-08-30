import { type Actions, redirect } from '@sveltejs/kit';
import { jwtDecode } from 'jwt-decode';
import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { getActionFailure, getFormRecord } from '$lib/utils/action-utils';

type OutputType = {
	email: string;
};

const resetPasswordSchema = z.object({
	password: z.string(),
	confirmPassword: z.string()
});

export const load: PageServerLoad<OutputType> = async ({ params }) => {
	return jwtDecode(params.token) as OutputType;
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
		} catch (err: any) {
			switch (err.status) {
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
