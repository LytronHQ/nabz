import { test, expect } from 'vitest';
import { get } from 'svelte/store';
import ErrorStore from './error-store';

test('stamps the real HTTP status even when the body omits it', async () => {
	// A 400 validation body is just { message, errors } — no `status` field.
	const store = new ErrorStore();
	const res = new Response(
		JSON.stringify({
			success: false,
			message: 'Invalid data. Please try again.',
			errors: [{ code: 'too_small', message: 'Name is required', field: 'name' }]
		}),
		{ status: 400, headers: { 'content-type': 'application/json' } }
	);

	const isError = await store.fromResponseIfError(res);
	const value = get(store.store);

	expect(isError).toBe(true);
	expect(value?.status).toBe(400); // must reflect the HTTP status, not undefined
	expect(value?.errors?.[0]).toMatchObject({ field: 'name', message: 'Name is required' });
});

test('a successful response clears the error and reports no error', async () => {
	const store = new ErrorStore();
	const res = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

	const isError = await store.fromResponseIfError(res);

	expect(isError).toBe(false);
	expect(get(store.store)).toBeNull();
});
