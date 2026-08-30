import { writable } from 'svelte/store';

export type ToastType = 'success' | 'error' | 'info';

export interface Toast {
	id: number;
	type: ToastType;
	message: string;
}

const store = writable<Toast[]>([]);
export const toasts = store;

let nextId = 1;
const DEFAULT_TIMEOUT = 4000;
// Cap how many toasts are visible at once — if a burst fires, only the newest
// few show (older ones drop off) rather than filling the screen.
const MAX_TOASTS = 4;

export function dismissToast(id: number) {
	store.update((list) => list.filter((t) => t.id !== id));
}

/**
 * Show a transient toast. Feedback for something the user just did — success
 * confirmations and system-level errors — as opposed to inline field validation.
 */
export function pushToast(type: ToastType, message: string, timeout = DEFAULT_TIMEOUT): number {
	const id = nextId++;
	// Append newest at the end (rendered nearest the corner); trim to the newest
	// MAX_TOASTS so a rapid burst can't stack past the cap.
	store.update((list) => [...list, { id, type, message }].slice(-MAX_TOASTS));
	if (timeout > 0) {
		// setTimeout is a no-op during SSR; toasts are only pushed from browser events.
		setTimeout(() => dismissToast(id), timeout);
	}
	return id;
}
