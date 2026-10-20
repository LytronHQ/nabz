import { type Actions, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { getActionFailure, getFormRecord } from '#lib/utils/action-utils.js';
import { changePassword } from '#lib/server/password.js';

export type SignInMethod = { provider: string; linkId: string | null; since: string | null };

// The /account?connect=... outcomes /auth/callback reports (#622).
const CONNECT_OUTCOMES = ['connected', 'cancelled', 'failed', 'taken'] as const;

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/signin');
	// `user` (name, email, avatar URL, verified) already comes from the root
	// layout load. Sign-in methods (#622): the providers PocketBase has on, and
	// which of them this user has linked. _externalAuths' built-in owner rule
	// lets the user read their own links with their own token.
	const userId = locals.user.id;
	const [methods, links] = await Promise.all([
		locals
			.pb!.collection('users')
			.listAuthMethods()
			.catch(() => null),
		locals
			.pb!.collection('_externalAuths')
			.getFullList({ filter: locals.pb!.filter('recordRef = {:id}', { id: userId }) })
			.catch((err) => {
				console.error('listing sign-in methods failed', (err as Error)?.message);
				return null;
			})
	]);
	const available = methods?.oauth2?.enabled ? methods.oauth2.providers.map((p) => p.name) : [];
	const signInMethods: SignInMethod[] = available.map((provider) => {
		const link = links?.find((l) => l.provider === provider);
		return { provider, linkId: link?.id ?? null, since: link?.created ?? null };
	});
	const outcome = url.searchParams.get('connect');
	const provider = url.searchParams.get('provider') ?? '';
	return {
		signInMethods,
		// null when the links could not be read: the card then says so rather than
		// showing every provider as not connected.
		signInMethodsError: links === null,
		connect: (CONNECT_OUTCOMES as readonly string[]).includes(outcome ?? '')
			? { outcome: outcome as (typeof CONNECT_OUTCOMES)[number], provider }
			: null
	};
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

const disconnectSchema = z.object({ linkId: z.string().min(1) });

export const actions = {
	// Disconnect a GitHub/Google sign-in (#622). The owner rule on _externalAuths
	// refuses another user's link; email + password (or a reset link) still work.
	async disconnect({ locals, request }) {
		if (!locals.user) return notSignedIn();
		const form = await getFormRecord(request, disconnectSchema);
		if (!form) return fail(400, { success: false, message: 'Nothing to disconnect.' });
		try {
			await locals.pb!.collection('_externalAuths').delete(form.linkId);
		} catch (err) {
			return getActionFailure(err, 'Could not disconnect it. Please try again.');
		}
		return { success: true, message: 'Disconnected. You can connect it again at any time.' };
	},

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
		} catch (err) {
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
		} catch (err) {
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
		} catch (err) {
			return getActionFailure(err, 'Could not request the email change. Please try again later.');
		}
	},

	// Re-send the verification email for an unverified account.
	async resendVerification({ locals }) {
		if (!locals.user?.email) return notSignedIn();
		try {
			await locals.pb!.collection('users').requestVerification(locals.user.email);
			return { success: true, message: `Verification email sent to ${locals.user.email}.` };
		} catch (err) {
			return getActionFailure(
				err,
				'Could not send the verification email. Please try again later.'
			);
		}
	}
} satisfies Actions;
