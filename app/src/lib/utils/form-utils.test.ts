import { test, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { routeSaveError } from './form-utils';
import { toasts, dismissToast } from '$lib/stores/toast-store';
import ApiError from '$lib/models/api-error';

beforeEach(() => {
	for (const t of get(toasts)) dismissToast(t.id);
});

test('a 400 validation error routes to inline field errors (keyed lowercase), no toast', () => {
	const err = new ApiError(false, '', 400, [{ field: 'Name', message: 'is required' }]);
	expect(routeSaveError(err)).toEqual({ name: 'is required' });
	expect(get(toasts).length).toBe(0);
});

test('a non-validation error toasts and returns an empty field-error map', () => {
	const err = new ApiError(false, '', 500, []);
	expect(routeSaveError(err)).toEqual({});
	const list = get(toasts);
	expect(list.length).toBe(1);
	expect(list[0].type).toBe('error');
});
