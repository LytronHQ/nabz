<script lang="ts">
	// Token inline alert (#168) — replaces flowbite's <Alert>. A hairline card with

	interface Props {
		// a status-coloured left accent and wash; both themes via tokens.
		tone?: 'success' | 'error' | 'info';
		children?: import('svelte').Snippet;
	}

	let { tone = 'info', children }: Props = $props();
</script>

<div class="alert {tone}" role="alert">{@render children?.()}</div>

<style>
	.alert {
		border: 1px solid var(--border);
		border-left-width: 3px;
		border-radius: var(--radius-btn);
		padding: 9px 12px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--ink);
	}
	.success {
		border-left-color: var(--up);
		background: var(--up-wash);
	}
	.error {
		border-left-color: var(--down);
		background: var(--down-wash);
	}
	.info {
		border-left-color: var(--accent);
		background: var(--accent-wash);
	}
</style>
