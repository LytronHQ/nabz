<script lang="ts">
	// Token switch (#168) — a native checkbox styled as a switch, replacing

	interface Props {
		// flowbite's <Toggle>. Two-way `checked` binding; the label is the default slot.
		checked?: boolean;
		children?: import('svelte').Snippet;
	}

	let { checked = $bindable(false), children }: Props = $props();
</script>

<label class="toggle">
	<input type="checkbox" bind:checked />
	<span class="track"><span class="thumb"></span></span>
	<span class="lbl">{@render children?.()}</span>
</label>

<style>
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 9px;
		cursor: pointer;
		font-size: 14px;
		color: var(--ink);
	}
	.toggle input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
	}
	.track {
		position: relative;
		flex: 0 0 auto;
		width: 38px;
		height: 22px;
		border-radius: 999px;
		background: var(--border-strong);
		transition: background 0.15s;
	}
	.thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--surface);
		transition: transform 0.15s;
	}
	.toggle input:checked + .track {
		background: var(--accent);
	}
	.toggle input:checked + .track .thumb {
		transform: translateX(16px);
	}
	.toggle input:focus-visible + .track {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.lbl:empty {
		display: none;
	}
</style>
