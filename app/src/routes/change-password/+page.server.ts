import { type Actions, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { getActionFailure, getFormRecord } from '$lib/utils/action-utils';
import { changePassword } from '$lib/server/password';

// The forced password-change page (#392). Deliberately its own route rather than
// a redirect to /account: the gate's promise is that nothing else is reachable
// until the password changes, and /account also offers profile, email and avatar
// editing. A dedicated page keeps that promise literally true.
//
// It shares the change logic with /account?/changePassword, so the flag is
// cleared identically by both.

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/signin');
	// Reachable deliberately when the flag is NOT set — someone can always change
	// their password here — so the page adapts its copy rather than bouncing.
	return { forced: Boolean(locals.user.must_change_password) };
};

const passwordSchema = z.object({
	oldPassword: z.string().min(1),
	password: z.string().min(1),
	passwordConfirm: z.string().min(1)
});

export const actions = {
	async default({ locals, request }) {
		if (!locals.user) return fail(401, { success: false, message: 'You are not signed in.' });
		const data = await getFormRecord(request, passwordSchema);
		if (!data)
			return getActionFailure({ status: 400 }, 'Please fill in all three password fields.');
		if (data.password !== data.passwordConfirm)
			return getActionFailure({ status: 400 }, 'The new passwords do not match.');

		const res = await changePassword(locals.pb!, locals.user.id, locals.user.email, data);
		if (!res.ok) {
			return getActionFailure(
				res.error,
				'Could not change your password. Check your current password and try again.'
			);
		}
		// The flag is cleared, so the gate in hooks.server.ts no longer fires and
		// the dashboard is reachable. Re-auth failures land on sign-in instead,
		// where the new password works.
		throw redirect(303, res.reauthenticated ? '/dashboard' : '/signin');
	}
} satisfies Actions;
