import type { PageServerLoad } from './$types';

type OutputType = {
	success: boolean;
	message?: string;
};

export const load: PageServerLoad<OutputType> = async ({ locals, params }) => {
	try {
		await locals.pb?.collection('users').confirmVerification(params.token);
		return {
			success: true,
			message: 'Successfully verified your email address. You can now login.'
		};
	} catch (err: any) {
		switch (err.status) {
			case 400:
				return {
					success: false,
					message: 'Invalid verification token. Please try again.'
				};
			case 403:
				return {
					success: false,
					message: err.response.message ?? 'Unable to verify, please try again.'
				};

			default:
				return {
					success: false,
					message: 'An error occurred while trying to verify the email. Please try again later.'
				};
		}
	}
};
