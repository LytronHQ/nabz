<script lang="ts">
	import { updated } from '$app/state';

	// SvelteKit polls for a new build (svelte.config.js `version.pollInterval`).
	// An installed copy has no address bar or reload button, so it has to offer
	// the reload itself; otherwise it runs the old build until closed (#493).
	let dismissed = $state(false);
</script>

{#if updated.current && !dismissed}
	<div class="update-banner" role="status">
		<span>A new version of nabz is ready.</span>
		<button type="button" class="btn btn-primary" onclick={() => location.reload()}>
			Reload
		</button>
		<button
			type="button"
			class="update-dismiss"
			aria-label="Dismiss"
			onclick={() => (dismissed = true)}>×</button
		>
	</div>
{/if}

<style>
	.update-banner {
		position: fixed;
		left: 50%;
		bottom: 16px;
		transform: translateX(-50%);
		z-index: 60;
		display: flex;
		align-items: center;
		gap: 12px;
		/* max-content, or left: 50% leaves it half the viewport to shrink into and
		   the message wraps one word per line on a phone. */
		width: max-content;
		max-width: calc(100vw - 32px);
		padding: 10px 12px 10px 16px;
		background: var(--surface);
		color: var(--ink);
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		font-size: 13.5px;
	}
	.update-dismiss {
		background: none;
		border: 0;
		color: var(--ink-3);
		font-size: 18px;
		line-height: 1;
		padding: 2px 4px;
		cursor: pointer;
	}
</style>
