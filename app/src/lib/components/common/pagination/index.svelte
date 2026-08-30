<script lang="ts">
	import type PaginationData from '$lib/models/pagination-data';

	interface Props {
		data: PaginationData;
		/** Called after `data.current` moves. Replaces the old `on:update` event. */
		onupdate?: (detail: { page: number }) => void;
	}

	let { data = $bindable(), onupdate = undefined }: Props = $props();

	function gotoPrevious() {
		if (data.current > 1) goto(data.current - 1);
	}
	function gotoNext() {
		if (data.current < data.totalPages) goto(data.current + 1);
	}
	function goto(page: number) {
		data.current = page;
		onupdate?.({ page: data.current });
	}
</script>

{#if data}
	<div class="flex flex-col md:flex-row items-center gap-3 my-2">
		<div class="md:w-full mut" style="font-size:13px">
			Page {data.current} of {data.totalPages} of {data.totalItems} records.
		</div>
		{#if data.isVisible}
			<div class="pager">
				<button
					type="button"
					class="pg"
					onclick={gotoPrevious}
					disabled={!data.isPreviousEnabled}
					aria-label="Previous page"
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.2"
						stroke-linecap="round"
						stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg
					>
				</button>
				{#each data.pages as item, i (i)}
					{#if item === '…'}
						<span class="pg ellipsis">…</span>
					{:else if item === data.current}
						<button type="button" class="pg on" aria-current="page">{item}</button>
					{:else}
						<button type="button" class="pg" onclick={() => goto(item)}>{item}</button>
					{/if}
				{/each}
				<button
					type="button"
					class="pg"
					onclick={gotoNext}
					disabled={!data.isNextEnabled}
					aria-label="Next page"
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.2"
						stroke-linecap="round"
						stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg
					>
				</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	.pager {
		display: inline-flex;
		flex: 0 0 auto; /* never shrink beside the full-width label — else buttons clip */
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		overflow: hidden;
		max-width: 100%;
	}
	.pg {
		min-width: 32px;
		height: 32px;
		padding: 0 9px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--surface);
		color: var(--ink);
		border: 0;
		border-left: 1px solid var(--border);
		font-size: 13px;
		cursor: pointer;
	}
	.pg:first-child {
		border-left: 0;
	}
	.pg:hover:not(:disabled):not(.on) {
		background: var(--surface-2);
	}
	.pg.on {
		background: var(--accent);
		color: var(--brand-contrast);
		cursor: default;
	}
	.pg:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.pg.ellipsis {
		cursor: default;
		color: var(--ink-3);
	}
	.pg svg {
		width: 15px;
		height: 15px;
	}
</style>
