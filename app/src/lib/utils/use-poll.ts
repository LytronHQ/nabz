import { onMount, onDestroy } from 'svelte';

/**
 * Poll `fn` every `ms` while the component is mounted, then clean up — the
 * repeated `onMount(setInterval)` / `onDestroy(clearInterval)` idiom (#167) in one
 * place. Call it once during component init (it registers its own lifecycle
 * hooks). Pass `{ immediate: true }` to also run `fn` once on mount. Multiple
 * calls per component are fine (e.g. a 1s "now" tick plus a 10s data refresh).
 */
export function usePoll(fn: () => void, ms: number, opts?: { immediate?: boolean }): void {
	let id: ReturnType<typeof setInterval>;
	onMount(() => {
		if (opts?.immediate) fn();
		id = setInterval(fn, ms);
	});
	onDestroy(() => clearInterval(id));
}
