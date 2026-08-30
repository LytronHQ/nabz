<script lang="ts">
	// Standard page header — a title, an optional muted sub-line, and an optional
	// `actions` slot (the right-hand toolbar). Replaces the copy-pasted `.page-head`
	// block on every app page (#164). Styling is the global `.page-head` / `.sub` /

	interface Props {
		// `.toolbar` classes in app.css, so this carries no styles of its own.
		title: string;
		sub?: string;
		actions?: import('svelte').Snippet;
	}

	let { title, sub = '', actions }: Props = $props();
</script>

<div class="page-head">
	<div>
		<h1>{title}</h1>
		{#if sub}<div class="sub">{sub}</div>{/if}
	</div>
	{#if actions}
		<div class="toolbar">{@render actions?.()}</div>
	{/if}
</div>
