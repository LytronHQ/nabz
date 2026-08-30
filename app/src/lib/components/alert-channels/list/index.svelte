<script lang="ts">
	import { resolve } from '$app/paths';
	import type { AlertChannelItem } from '$lib/models/alert-channel';
	import type { EntityIdType } from '$lib/constants';
	import { Icon, Pill } from '$lib/components/common';
	import { channelTarget } from '$lib/utils/channel-display';

	interface Props {
		data: AlertChannelItem[];
		/** Replace the old `on:edit` / `on:delete` component events. */
		onedit?: (detail: { id: EntityIdType }) => void;
		ondelete?: (detail: { id: EntityIdType }) => void;
	}

	let { data, onedit = undefined, ondelete = undefined }: Props = $props();
</script>

<div class="card">
	<div style="overflow-x:auto">
		<table class="data-table">
			<thead>
				<tr>
					<th>Type</th>
					<th>Name</th>
					<th>Target</th>
					<th>Enabled</th>
					<th class="r">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each data as item (item.id)}
					<tr>
						<td><span class="zone-tag">{item.type}</span></td>
						<td class="ch-name" class:mut={!item.name}>
							{#if item.name}
								<a class="name-link" href={resolve('/alerts/[id]', { id: item.id! })}>{item.name}</a
								>
							{:else}
								<span title="No name set">—</span>
							{/if}
						</td>
						<td class="val">
							<a class="target-link" href={resolve('/alerts/[id]', { id: item.id! })}
								>{channelTarget(item)}</a
							>
						</td>
						<td>
							{#if item.enabled}
								<Pill tone="up" label="On" />
							{:else}
								<Pill tone="paused" label="Off" />
							{/if}
						</td>
						<td class="r">
							<div class="row-actions">
								<button
									type="button"
									title="Edit"
									aria-label="Edit"
									onclick={() => onedit?.({ id: item.id! })}
								>
									<Icon name="edit" />
								</button>
								<button
									type="button"
									title="Delete"
									aria-label="Delete"
									class="danger"
									onclick={() => ondelete?.({ id: item.id! })}
								>
									<Icon name="trash" />
								</button>
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<style>
	.ch-name {
		font-weight: 500;
		color: var(--ink);
	}
	.ch-name.mut {
		font-weight: 400;
		color: var(--ink-3);
	}
	.name-link {
		color: inherit;
		text-decoration: none;
	}
	.name-link:hover {
		color: var(--accent-strong);
		text-decoration: underline;
	}
	.target-link {
		color: var(--ink-2);
		text-decoration: none;
	}
	.target-link:hover {
		color: var(--accent-strong);
		text-decoration: underline;
	}
	.row-actions {
		display: inline-flex;
		gap: 4px;
		justify-content: flex-end;
	}
	.row-actions button {
		display: inline-grid;
		place-items: center;
		width: 30px;
		height: 30px;
		border: 1px solid transparent;
		border-radius: var(--radius-btn);
		background: transparent;
		color: var(--ink-3);
		cursor: pointer;
	}
	.row-actions button:hover {
		background: var(--surface-2);
		color: var(--ink);
		border-color: var(--border);
	}
	.row-actions button.danger:hover {
		color: var(--down);
	}
	.row-actions :global(svg) {
		width: 16px;
		height: 16px;
	}
</style>
