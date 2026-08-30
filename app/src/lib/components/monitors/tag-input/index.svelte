<script lang="ts">
	// Tag editor (#142): entered tags render as removable pills; typing + Enter or
	// comma adds one, Backspace on an empty field removes the last. `tags` is bound

	interface Props {
		// to the monitor's `string[]`.
		tags?: string[];
	}

	let { tags = $bindable([]) }: Props = $props();
	let draft = $state('');
	let input: HTMLInputElement | undefined = $state();

	function add(raw: string) {
		for (const part of raw.split(',')) {
			const t = part.trim().replace(/^#+/, '');
			if (t && !tags.includes(t)) tags = [...tags, t];
		}
		draft = '';
	}
	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			add(draft);
		} else if (e.key === 'Backspace' && draft === '' && tags.length) {
			tags = tags.slice(0, -1);
		}
	}
	function remove(t: string) {
		tags = tags.filter((x) => x !== t);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="tag-input form-input" onclick={() => input!.focus()}>
	{#each tags as t (t)}
		<span class="tag-chip"
			>{t}<button
				type="button"
				onclick={(e) => {
					e.stopPropagation();
					remove(t);
				}}
				aria-label={`Remove ${t}`}>×</button
			></span
		>
	{/each}
	<input
		bind:this={input}
		class="tag-draft"
		bind:value={draft}
		onkeydown={onKeydown}
		onblur={() => add(draft)}
		placeholder={tags.length ? '' : 'prod, api, eu…'}
	/>
</div>

<style>
	.tag-input {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
		padding: 6px 10px;
		cursor: text;
	}
	/* Show focus on the whole control as one unit, like a normal input — not as a
	   ring hugging the inner text field. */
	.tag-input:focus-within {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-wash);
	}
	.tag-chip {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		background: var(--accent-wash);
		color: var(--accent-strong);
		border-radius: var(--radius-btn);
		padding: 2px 4px 2px 9px;
		font-size: 12.5px;
	}
	.tag-chip button {
		border: 0;
		background: none;
		color: inherit;
		cursor: pointer;
		font-size: 15px;
		line-height: 1;
		padding: 0 2px;
		opacity: 0.7;
	}
	.tag-chip button:hover {
		opacity: 1;
	}
	.tag-draft {
		flex: 1 1 90px;
		min-width: 90px;
		border: 0;
		outline: none;
		background: transparent;
		color: var(--ink);
		font-size: 14px;
		padding: 2px 2px;
	}
	/* The container carries the focus ring; suppress any ring on the inner input
	   so the typed text isn't boxed in tight against the left edge. */
	.tag-draft:focus {
		box-shadow: none;
	}
</style>
