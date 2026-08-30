import { test, expect, vi } from 'vitest';
import { load, actions } from './+page.server';

function setup() {
	const users = {
		update: vi.fn(async (_id: string, _body: unknown) => ({ id: 'u1' })),
		authWithPassword: vi.fn(async () => ({})),
		requestPasswordReset: vi.fn(async () => true),
		requestEmailChange: vi.fn(async () => true),
		requestVerification: vi.fn(async () => true)
	};
	const locals = {
		user: { id: 'u1', email: 'a@b.com', name: 'A' },
		pb: { collection: () => users, authStore: { clear: vi.fn() } }
	} as any;
	return { locals, users };
}

// A minimal Request stand-in: the actions only ever call `request.formData()`,
// and building a real Request from a FormData doesn't set a Content-Type in the
// test env (so .formData() throws). Returning the FormData directly sidesteps that.
function req(fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	return { formData: async () => fd } as unknown as Request;
}

test('load redirects to /signin when not authenticated', async () => {
	await expect(load({ locals: { user: null } } as any)).rejects.toMatchObject({
		status: 303,
		location: '/signin'
	});
});

test('load resolves for an authenticated user', async () => {
	const { locals } = setup();
	await expect(load({ locals } as any)).resolves.toBeTruthy();
});

test('updateProfile sends the display name to PocketBase', async () => {
	const { locals, users } = setup();
	const res: any = await actions.updateProfile({
		locals,
		request: req({ name: 'New Name' })
	} as any);
	expect(users.update).toHaveBeenCalledTimes(1);
	const [id, payload] = users.update.mock.calls[0]!;
	expect(id).toBe('u1');
	expect((payload as FormData).get('name')).toBe('New Name');
	expect(res.success).toBe(true);
});

test('changePassword updates the password then re-auths to keep the session', async () => {
	const { locals, users } = setup();
	const res: any = await actions.changePassword({
		locals,
		request: req({ oldPassword: 'old', password: 'newpass', passwordConfirm: 'newpass' })
	} as any);
	// must_change_password rides along in the SAME update (#392): changing a
	// password invalidates the token, so clearing the flag afterwards would fail
	// and strand a seeded user behind the forced-change gate.
	expect(users.update).toHaveBeenCalledWith('u1', {
		oldPassword: 'old',
		password: 'newpass',
		passwordConfirm: 'newpass',
		must_change_password: false
	});
	expect(users.authWithPassword).toHaveBeenCalledWith('a@b.com', 'newpass');
	expect(res.success).toBe(true);
});

test('changePassword fails (no PB call) when a field is missing', async () => {
	const { locals, users } = setup();
	const res: any = await actions.changePassword({
		locals,
		request: req({ oldPassword: 'old' })
	} as any);
	expect(users.update).not.toHaveBeenCalled();
	expect(res.status).toBe(400);
	expect(res.data.success).toBe(false);
});

test('changeEmail requests the change and echoes the new address', async () => {
	const { locals, users } = setup();
	const res: any = await actions.changeEmail({
		locals,
		request: req({ newEmail: 'new@example.com' })
	} as any);
	expect(users.requestEmailChange).toHaveBeenCalledWith('new@example.com');
	expect(res.success).toBe(true);
	expect(res.message).toContain('new@example.com');
});

test('changeEmail rejects an invalid address without calling PB', async () => {
	const { locals, users } = setup();
	const res: any = await actions.changeEmail({
		locals,
		request: req({ newEmail: 'not-an-email' })
	} as any);
	expect(users.requestEmailChange).not.toHaveBeenCalled();
	expect(res.status).toBe(400);
});

test('sendPasswordReset emails the current address', async () => {
	const { locals, users } = setup();
	const res: any = await actions.sendPasswordReset({ locals } as any);
	expect(users.requestPasswordReset).toHaveBeenCalledWith('a@b.com');
	expect(res.success).toBe(true);
});

test('resendVerification emails the current address', async () => {
	const { locals, users } = setup();
	const res: any = await actions.resendVerification({ locals } as any);
	expect(users.requestVerification).toHaveBeenCalledWith('a@b.com');
	expect(res.success).toBe(true);
});
