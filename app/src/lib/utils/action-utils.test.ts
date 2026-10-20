import { describe, expect, test, vi } from 'vitest';

vi.mock('$app/env/private', () => ({ PKCE_FLOW_ENCRYPTION_KEY: '' }));

import { getActionFailure } from './action-utils';

// SvelteKit 3 sends an enhanced action's failure with the status given to
// fail(). A PocketBase error with no HTTP status (status 0: PB unreachable) made
// that `Response.json(..., { status: 0 })`, which throws, so a sign-in during a
// PocketBase outage became a 500 instead of the form's own error message.
describe('getActionFailure', () => {
	test('keeps a PocketBase HTTP error status', () => {
		expect(getActionFailure({ status: 400 }, 'Invalid').status).toBe(400);
		expect(getActionFailure({ status: 404 }, 'Not found').status).toBe(404);
	});

	test.each([0, undefined, 200, 302, 600])('maps status %s to 503, a valid failure', (status) => {
		const failure = getActionFailure({ status }, 'Something went wrong');
		expect(failure.status).toBe(503);
		expect(failure.data).toMatchObject({ success: false, message: 'Something went wrong' });
	});
});
