<script lang="ts">
	import { resolve } from '$app/paths';
	import type { MonitorItem } from '$lib/models/monitor';
	import type { EntityIdType } from '$lib/constants';
	import { Icon, StatusBadge } from '$lib/components/common';
	import { formatUptime, formatRelativeTime, isInMaintenance } from '$lib/utils/format-utils';

	interface Props {
		data: MonitorItem[];
		/** Replace the old `on:tag` / `on:pause` / `on:edit` / `on:delete` events. */
		ontag?: (detail: { tag: string }) => void;
		onpause?: (detail: { id: EntityIdType }) => void;
		onedit?: (detail: { id: EntityIdType }) => void;
		ondelete?: (detail: { id: EntityIdType }) => void;
	}

	let {
		data,
		ontag = undefined,
		onpause = undefined,
		onedit = undefined,
		ondelete = undefined
	}: Props = $props();
</script>

<div class="card">
	<div style="overflow-x:auto">
		<table class="data-table">
			<thead>
				<tr>
					<th>Name</th>
					<th>Type</th>
					<th>Status</th>
					<th class="r">Uptime 24h</th>
					<th class="r">Last check</th>
					<th class="r">Last downtime</th>
					<th class="r">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each data as item (item.id)}
					<tr>
						<td>
							<!-- preload on tap, not hover: a monitor's detail data changes fast right
							     after creation, and a hover-preloaded snapshot would render stale (#134). -->
							<a
								href={resolve('/monitors/[id]', { id: item.id! })}
								data-sveltekit-preload-data="tap"
								style="text-decoration:none;color:inherit;display:block"
							>
								<div class="m-name">{item.name}</div>
								<div class="m-url">{item.target}</div>
							</a>
							{#if item.tags?.length}
								<div class="m-tags">
									{#each item.tags as t (t)}
										<button
											type="button"
											class="m-tag"
											onclick={() => ontag?.({ tag: t })}
											title="Filter by {t}">{t}</button
										>
									{/each}
								</div>
							{/if}
						</td>
						<td class="val mut">{item.type}</td>
						<td>
							<div style="display:inline-flex;gap:6px;flex-wrap:wrap">
								<StatusBadge status={item.status} />
								{#if isInMaintenance(item.maintenanceWindows)}<StatusBadge
										status="maintenance"
									/>{/if}
							</div>
						</td>
						<td class="r val">{formatUptime(item.uptime24h)}</td>
						<td class="r val mut">{formatRelativeTime(item.lastChecked)}</td>
						<!-- A timestamp, not a status — muted, never red/green (reserved for up/down). -->
						<td class="r val mut">
							{#if item.lastDowntime}{formatRelativeTime(item.lastDowntime)}{:else}<span
									class="ld-none">No incidents recorded</span
								>{/if}
						</td>
						<td class="r">
							<div class="row-actions">
								<button
									type="button"
									title={item.enabled ? 'Pause' : 'Resume'}
									aria-label={item.enabled ? 'Pause' : 'Resume'}
									onclick={() => onpause?.({ id: item.id! })}
								>
									{#if item.enabled}
										<Icon name="pause" />
									{:else}
										<Icon name="play" />
									{/if}
								</button>
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
	.m-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 5px;
	}
	.m-tag {
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: var(--ink-2);
		border-radius: var(--radius-btn);
		padding: 1px 7px;
		font-size: 11px;
		cursor: pointer;
	}
	.m-tag:hover {
		color: var(--accent-strong);
		border-color: var(--accent-wash);
	}
	/* "No incidents recorded" placeholder — clearly a non-value, not an alert. */
	.ld-none {
		font-size: 12px;
		font-style: italic;
		color: var(--ink-3);
	}
</style>
