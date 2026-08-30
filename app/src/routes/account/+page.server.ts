import { type Actions, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { getActionFailure, getFormRecord } from '$lib/utils/action-utils';
import { changePassword } from '$lib/server/password';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/signin');
	// `user` (name, email, avatar URL, verified) already comes from the root
	// layout load; nothing extra to fetch here.
	return {};
};

const passwordSchema = z.object({
	oldPassword: z.string().min(1),
	password: z.string().min(1),
	passwordConfirm: z.string().min(1)
});

const emailSchema = z.object({
	newEmail: z.string().email()
});

const notSignedIn = () => fail(401, { success: false, message: 'You are not signed in.' });

export const actions = {
	// Display name + avatar. Avatar is a PocketBase file field, so this goes up as
	// multipart FormData (mirrors the OAuth avatar upload in /auth/callback).
	async updateProfile({ locals, request }) {
		if (!locals.user) return notSignedIn();
		const fd = await request.formData();
		const payload = new FormData();
		payload.append('name', String(fd.get('name') ?? ''));
		const avatar = fd.get('avatar');
		if (fd.get('removeAvatar')) {
			payload.append('avatar', ''); // PB clears a file field on empty value
		} else if (avatar instanceof File && avatar.size > 0) {
			payload.append('avatar', avatar);
		}
		try {
			await locals.pb!.collection('users').update(locals.user.id, payload);
			return { success: true, message: 'Profile updated.' };
		} catch (err: any) {
			return getActionFailure(err, 'Could not update your profile. Please try again.');
		}
	},

	// Change password while signed in. PB verifies oldPassword; the change rotates
	// the token key, so we immediately re-auth to keep the session alive.
	async changePassword({ locals, request }) {
		if (!locals.user) return notSignedIn();
		const data = await getFormRecord(request, passwordSchema);
		if (!data)
			return getActionFailure({ status: 400 }, 'Please fill in all three password fields.');
		// Shared with the forced-change page so both clear must_change_password.
		const res = await changePassword(locals.pb!, locals.user.id, locals.user.email, data);
		if (!res.ok) {
			return getActionFailure(
				res.error,
				'Could not change your password. Check your current password and try again.'
			);
		}
		return res.reauthenticated
			? { success: true, message: 'Your password has been changed.' }
			: { success: true, message: 'Your password has been changed — please sign in again.' };
	},

	// Email a reset link to the current address (the logged-out reset flow, on demand).
	async sendPasswordReset({ locals }) {
		if (!locals.user?.email) return notSignedIn();
		try {
			await locals.pb!.collection('users').requestPasswordReset(locals.user.email);
			return { success: true, message: `Password-reset link sent to ${locals.user.email}.` };
		} catch (err: any) {
			return getActionFailure(err, 'Could not send the reset email. Please try again later.');
		}
	},

	// Start an email change — PB emails a confirmation link to the NEW address; the
	// change only applies once the user confirms it at /auth/confirm-email-change.
	async changeEmail({ locals, request }) {
		if (!locals.user) return notSignedIn();
		const data = await getFormRecord(request, emailSchema);
		if (!data) return getActionFailure({ status: 400 }, 'Please enter a valid email address.');
		try {
			await locals.pb!.collection('users').requestEmailChange(data.newEmail);
			return {
				success: true,
				message: `Confirmation sent to ${data.newEmail}. Open the link there to finish the change.`
			};
		} catch (err: any) {
			return getActionFailure(err, 'Could not request the email change. Please try again later.');
		}
	},

	// Re-send the verification email for an unverified account.
	async resendVerification({ locals }) {
		if (!locals.user?.email) return notSignedIn();
		try {
			await locals.pb!.collection('users').requestVerification(locals.user.email);
			return { success: true, message: `Verification email sent to ${locals.user.email}.` };
		} catch (err: any) {
			return getActionFailure(
				err,
				'Could not send the verification email. Please try again later.'
			);
		}
	}
} satisfies Actions;
