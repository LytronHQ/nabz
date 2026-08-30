import { test, expect } from 'vitest';
import { get } from 'svelte/store';
import { toasts, pushToast, dismissToast } from './toast-store';

test('pushToast adds a toast and returns its id', () => {
	const before = get(toasts).length;
	const id = pushToast('success', 'Saved', 0); // 0 = no auto-dismiss in this test
	const list = get(toasts);
	expect(list.length).toBe(before + 1);
	const t = list.find((x) => x.id === id);
	expect(t?.type).toBe('success');
	expect(t?.message).toBe('Saved');
	dismissToast(id);
});

test('dismissToast removes the toast', () => {
	const id = pushToast('error', 'Nope', 0);
	expect(get(toasts).some((t) => t.id === id)).toBe(true);
	dismissToast(id);
	expect(get(toasts).some((t) => t.id === id)).toBe(false);
});

test('a rapid burst is capped to the newest four, in order', () => {
	for (const t of get(toasts)) dismissToast(t.id); // clean slate
	for (let i = 0; i < 6; i++) pushToast('info', `m${i}`, 0);
	const list = get(toasts);
	expect(list.length).toBe(4);
	// oldest two (m0, m1) drop off; newest four kept oldest→newest.
	expect(list.map((t) => t.message)).toEqual(['m2', 'm3', 'm4', 'm5']);
	for (const t of get(toasts)) dismissToast(t.id);
});
