<script lang="ts">
	import { resolve } from '$app/paths';
	import { providerLabel as label } from '#lib/utils/oauth-providers.js';
	import ProviderMark from './provider-mark.svelte';

	// "Continue with GitHub / Google" on the sign-in and sign-up pages (#609), for
	// each provider PocketBase has on. Labelled buttons with inline marks: the
	// icon-only buttons before them fetched their icons from the Iconify API at
	// runtime, a third-party request on every visit to a sign-in page.
	interface Props {
		providers: { name: string }[];
	}

	let { providers }: Props = $props();
</script>

{#if providers.length}
	<div class="oauth">
		{#each providers as provider (provider.name)}
			<a
				class="btn btn-ghost btn-block"
				href={resolve('/auth/start/[provider]', { provider: provider.name })}
				data-sveltekit-reload
			>
				<ProviderMark name={provider.name} />
				Continue with {label(provider.name)}
			</a>
		{/each}
	</div>
	<div class="or" aria-hidden="true">
		<span></span><span class="mono">or with email</span><span></span>
	</div>
{/if}

<style>
	.oauth {
		display: grid;
		gap: 8px;
		margin-bottom: 4px;
	}
	.oauth .btn {
		color: var(--ink);
	}
	.or {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 14px 0 16px;
	}
	.or span:first-child,
	.or span:last-child {
		flex: 1;
		height: 1px;
		background: var(--border);
	}
	.or .mono {
		font-size: 11px;
		color: var(--ink-3);
	}
</style>
