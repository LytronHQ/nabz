<script lang="ts">
	import { onMount } from 'svelte';
	import { theme, setTheme, initAppearance, resolvedDark } from '#lib/appearance.js';

	// One-click light/dark switch for the public pages (#556), which have no user
	// menu to hold the full Appearance picker. It writes the same setting, so the
	// choice carries into the app after sign-in.
	let systemDark = $state(false);
	let dark = $derived($theme === 'dark' || ($theme === 'system' && systemDark));

	onMount(() => {
		initAppearance();
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		systemDark = mq.matches;
		const onChange = () => (systemDark = mq.matches);
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	});

	function toggle() {
		// Pick the opposite of what is on screen; a choice equal to the OS setting
		// goes back to following it, so a later OS switch is still honoured.
		const next = dark ? 'light' : 'dark';
		setTheme(resolvedDark('system') === (next === 'dark') ? 'system' : next);
	}
</script>

<button
	type="button"
	class="theme-toggle"
	onclick={toggle}
	aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
	title={dark ? 'Light theme' : 'Dark theme'}
>
	{#if dark}
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
			><circle cx="12" cy="12" r="4" /><path
				d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"
			/></svg
		>
	{:else}
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"><path d="M21 12.8A8.5 8.5 0 1111.2 3a6.6 6.6 0 009.8 9.8z" /></svg
		>
	{/if}
</button>

<style>
	.theme-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		padding: 0;
		border: 1px solid var(--border, var(--rule, currentColor));
		border-radius: 6px;
		background: transparent;
		color: var(--ink-2, currentColor);
		cursor: pointer;
		flex: none;
	}
	.theme-toggle:hover {
		color: var(--ink, currentColor);
	}
	.theme-toggle svg {
		width: 17px;
		height: 17px;
	}
</style>
