<script lang="ts">
	import { resolve } from '$app/paths';

	import { UserNav } from '$lib/components/common/user-nav';
	import { Toaster } from '$lib/components/common';
	import { afterNavigate } from '$app/navigation';
	import { browser } from '$app/environment';
	import '../app.css';

	let { data, children } = $props();
	let { user } = $derived(data);

	// Off-canvas sidebar drawer on small screens (#189). On desktop the sidebar is a
	// static column; below the breakpoint it slides in over a backdrop, opened by the
	// mobile top-bar hamburger and closed on navigate / Escape / backdrop tap.
	let navOpen = $state(false);
	afterNavigate(() => (navOpen = false));
	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') navOpen = false;
	}
	// Lock background scroll while the drawer is open.
	$effect(() => {
		if (browser) document.body.style.overflow = navOpen ? 'hidden' : '';
	});
</script>

<svelte:window onkeydown={onKeydown} />

<Toaster />

{#if user}
	<div class="app-shell" class:nav-open={navOpen}>
		<header class="app-topbar">
			<button
				type="button"
				class="app-burger"
				aria-label="Open menu"
				aria-expanded={navOpen}
				onclick={() => (navOpen = true)}
			>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg
				>
			</button>
			<a class="brand" href={resolve('/dashboard')}>
				<span class="mark"
					><svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="#fff"
						stroke-width="2.4"
						stroke-linecap="round"
						stroke-linejoin="round"><path d="M3 12h4l2.5-7 5 14 2.5-7H21" /></svg
					></span
				>
				<b>nabz</b>
			</a>
		</header>
		<UserNav {user} isAdmin={data.isAdmin} />
		<button
			type="button"
			class="app-backdrop"
			aria-label="Close menu"
			tabindex="-1"
			onclick={() => (navOpen = false)}
		></button>
		<main class="app-main">
			<div class="stack">
				{@render children?.()}
			</div>
		</main>
	</div>
{:else}
	{@render children?.()}
{/if}
