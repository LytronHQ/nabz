import type PocketBase from 'pocketbase';

/** The one place a user's password is changed (#392).
 *
 *  Shared by `/account?/changePassword` and the forced-change page, so the two
 *  cannot drift — in particular, so both clear `must_change_password`. A second
 *  copy of this that forgot to clear the flag would leave the user redirected in
 *  a loop forever, having done exactly what they were asked. */
export type ChangePasswordInput = {
	oldPassword: string;
	password: string;
	passwordConfirm: string;
};

export type ChangePasswordResult =
	| { ok: true; reauthenticated: boolean }
	| { ok: false; error: unknown };

/** Changes the password and clears the forced-change flag in ONE update.
 *
 *  One call, not two, because changing a password invalidates the current token:
 *  a follow-up write to clear the flag would be made with a dead token, fail, and
 *  leave the user permanently stuck behind the gate. */
export async function changePassword(
	pb: PocketBase,
	userId: string,
	email: string,
	input: ChangePasswordInput
): Promise<ChangePasswordResult> {
	try {
		await pb.collection('users').update(userId, {
			oldPassword: input.oldPassword,
			password: input.password,
			passwordConfirm: input.passwordConfirm,
			// Cleared here rather than in a separate request — see above. Harmless
			// for a user who never had it set.
			must_change_password: false
		});
	} catch (error) {
		return { ok: false, error };
	}

	// Re-auth so the session survives the change and the refreshed record carries
	// the cleared flag; without this the next request still reads the stale value
	// and bounces the user back to the gate.
	try {
		await pb.collection('users').authWithPassword(email, input.password);
		return { ok: true, reauthenticated: true };
	} catch {
		return { ok: true, reauthenticated: false };
	}
}
