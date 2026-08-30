<script lang="ts">
	// The centered empty-state block (#166): an optional lead (`icon` slot — e.g. a
	// status Pill), a muted message, and an optional `action` slot (e.g. an
	// AddButton or a "Clear filters" button). `card` wraps it in a surface card;

	interface Props {
		// set card={false} when it already sits inside one.
		message?: string;
		card?: boolean;
		icon?: import('svelte').Snippet;
		action?: import('svelte').Snippet;
		children?: import('svelte').Snippet;
	}

	let { message = '', card = true, icon, action, children }: Props = $props();
</script>

<div class="empty" class:card>
	{@render icon?.()}
	{#if message}<p class="msg">{message}</p>{/if}
	{@render action?.()}
	{@render children?.()}
</div>

<style>
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		text-align: center;
		padding: 28px 16px;
	}
	.empty.card {
		padding: 32px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.msg {
		margin: 0;
		max-width: 46ch;
		color: var(--text-muted);
		font-size: 13.5px;
		line-height: 1.5;
	}
</style>
