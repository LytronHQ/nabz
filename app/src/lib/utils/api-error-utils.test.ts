import { test, expect } from 'vitest';
import { fieldErrorsFrom, isValidationError, friendlyMessage } from './api-error-utils';

test('fieldErrorsFrom maps and lowercases field names', () => {
	const err = {
		success: false,
		status: 400,
		message: 'Invalid data',
		errors: [
			{ field: 'Target', message: 'Required' },
			{ field: 'name', message: 'Too short' }
		]
	} as any;
	expect(fieldErrorsFrom(err)).toEqual({ target: 'Required', name: 'Too short' });
});

test('fieldErrorsFrom tolerates null/empty', () => {
	expect(fieldErrorsFrom(null)).toEqual({});
	expect(fieldErrorsFrom({ status: 500 } as any)).toEqual({});
});

test('isValidationError only for 400 with field errors', () => {
	expect(isValidationError({ status: 400, errors: [{ field: 'x', message: 'y' }] } as any)).toBe(
		true
	);
	expect(isValidationError({ status: 400, errors: [] } as any)).toBe(false);
	expect(isValidationError({ status: 500, errors: [{ field: 'x', message: 'y' }] } as any)).toBe(
		false
	);
	expect(isValidationError(null)).toBe(false);
});

test('friendlyMessage maps common statuses to plain language', () => {
	expect(friendlyMessage({ status: 0 } as any)).toMatch(/reach the server/i);
	expect(friendlyMessage(null)).toMatch(/reach the server/i);
	expect(friendlyMessage({ status: 403 } as any)).toMatch(/not allowed/i);
	expect(friendlyMessage({ status: 500 } as any)).toMatch(/our side/i);
	// Unmapped status falls back to the server's own message.
	expect(friendlyMessage({ status: 418, message: 'teapot' } as any)).toBe('teapot');
});
