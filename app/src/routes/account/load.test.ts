import { test, expect, vi } from 'vitest';
import { load, actions } from './+page.server';

// The fakes stub only what load and the actions touch, so events are deliberate partials.
type LoadEvent = Parameters<typeof load>[0];
type ActionEvent = Parameters<(typeof actions)[keyof typeof actions]>[0];
// Either a success payload or an ActionFailure ({ status, data }).
type ActionResult = {
	success?: boolean;
	message?: string;
	status?: number;
	data?: { success?: boolean };
};
const act = async (name: keyof typeof actions, event: object) =>
	(await actions[name](event as ActionEvent)) as ActionResult;

function setup() {
	const users = {
		update: vi.fn<(id: string, body: unknown) => Promise<{ id: string }>>(async () => ({
			id: 'u1'
		})),
		authWithPassword: vi.fn(async () => ({})),
		requestPasswordReset: vi.fn(async () => true),
		requestEmailChange: vi.fn(async () => true),
		requestVerification: vi.fn(async () => true),
		listAuthMethods: vi.fn(async () => ({ oauth2: { enabled: false, providers: [] } })),
		getFullList: vi.fn(async () => [])
	};
	const locals = {
		user: { id: 'u1', email: 'a@b.com', name: 'A' },
		pb: { collection: () => users, authStore: { clear: vi.fn() }, filter: (s: string) => s }
	};
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
	await expect(load({ locals: { user: null } } as object as LoadEvent)).rejects.toMatchObject({
		status: 303,
		location: '/signin'
	});
});

test('load resolves for an authenticated user', async () => {
	const { locals } = setup();
	await expect(
		load({ locals, url: new URL('https://nabz.example/account') } as object as LoadEvent)
	).resolves.toBeTruthy();
});

test('updateProfile sends the display name to PocketBase', async () => {
	const { locals, users } = setup();
	const res = await act('updateProfile', {
		locals,
		request: req({ name: 'New Name' })
	});
	expect(users.update).toHaveBeenCalledTimes(1);
	const [id, payload] = users.update.mock.calls[0]!;
	expect(id).toBe('u1');
	expect((payload as FormData).get('name')).toBe('New Name');
	expect(res.success).toBe(true);
});

test('changePassword updates the password then re-auths to keep the session', async () => {
	const { locals, users } = setup();
	const res = await act('changePassword', {
		locals,
		request: req({ oldPassword: 'old', password: 'newpass', passwordConfirm: 'newpass' })
	});
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
	const res = await act('changePassword', {
		locals,
		request: req({ oldPassword: 'old' })
	});
	expect(users.update).not.toHaveBeenCalled();
	expect(res.status).toBe(400);
	expect(res.data?.success).toBe(false);
});

test('changeEmail requests the change and echoes the new address', async () => {
	const { locals, users } = setup();
	const res = await act('changeEmail', {
		locals,
		request: req({ newEmail: 'new@example.com' })
	});
	expect(users.requestEmailChange).toHaveBeenCalledWith('new@example.com');
	expect(res.success).toBe(true);
	expect(res.message).toContain('new@example.com');
});

test('changeEmail rejects an invalid address without calling PB', async () => {
	const { locals, users } = setup();
	const res = await act('changeEmail', {
		locals,
		request: req({ newEmail: 'not-an-email' })
	});
	expect(users.requestEmailChange).not.toHaveBeenCalled();
	expect(res.status).toBe(400);
});

test('sendPasswordReset emails the current address', async () => {
	const { locals, users } = setup();
	const res = await act('sendPasswordReset', { locals });
	expect(users.requestPasswordReset).toHaveBeenCalledWith('a@b.com');
	expect(res.success).toBe(true);
});

test('resendVerification emails the current address', async () => {
	const { locals, users } = setup();
	const res = await act('resendVerification', { locals });
	expect(users.requestVerification).toHaveBeenCalledWith('a@b.com');
	expect(res.success).toBe(true);
});
