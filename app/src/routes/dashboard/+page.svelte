<script lang="ts">
	import { resolve } from '$app/paths';
	import { invalidateAll } from '$app/navigation';
	import { usePoll } from '$lib/utils/use-poll';
	import {
		Meta,
		PageHeader,
		Pill,
		StatusBadge,
		Sparkline,
		AddButton,
		EmptyState
	} from '$lib/components/common';
	import { formatMs, formatRelativeTime } from '$lib/utils/format-utils';

	let { data } = $props();

	let sc = $derived(data.statusCounts);
	let zones = $derived(data.zones ?? []);
	let monitors = $derived(data.monitors ?? []);
	let openIncidents = $derived(data.openIncidents ?? []);
	let healthyZones = $derived(zones.filter((z: any) => z.healthy).length);

	const tone = (s: string) =>
		(({ up: 'up', down: 'down', pending: 'pend', paused: 'paused' }) as any)[s] ?? 'accent';

	usePoll(() => invalidateAll(), 10000);
</script>

<Meta title="Dashboard" />

<PageHeader
	title="Overview"
	sub={`${sc.total} monitor${sc.total === 1 ? '' : 's'} · ${zones.length} zone${zones.length === 1 ? '' : 's'}`}
>
	{#snippet actions()}
		<AddButton label="Add monitor" href={resolve('/monitors/new')} />
	{/snippet}
</PageHeader>

<!-- stat tiles -->
<div class="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
	<div class="card stat">
		<div class="label">Fleet uptime · 24h</div>
		<div class="value">
			{#if data.fleetUptime == null}—{:else}{data.fleetUptime}<small>%</small>{/if}
		</div>
		<div class="delta mut">across all monitors</div>
	</div>
	<div class="card stat">
		<div class="label">Monitors up</div>
		<div class="value">{sc.up ?? 0}<small>/{sc.total}</small></div>
		<div class="delta">
			{#if sc.down}
				<Pill tone="down" label={`${sc.down} down`} style="padding:1px 7px" />
			{:else}
				<span class="mut">all healthy</span>
			{/if}
		</div>
	</div>
	<!-- Scheduled, not observed (#324). The figure is derived from configuration, so
	     it would stay exactly the same while every worker is dead — which is why it
	     is suppressed rather than merely relabelled when a zone heartbeat is stale.
	     A correctly-labelled number in a row of stat tiles still reads as throughput
	     at a glance, and on a product whose job is detecting failure, a number that
	     looks healthy through an outage is worse than no number. -->
	<div class="card stat" class:degraded={!data.scheduled.fleetLive}>
		<div class="label">Checks / min · scheduled</div>
		{#if data.scheduled.fleetLive}
			<div class="value">{data.scheduled.perMinute}</div>
			<div class="delta mut">from monitor intervals</div>
		{:else}
			<div class="value">—</div>
			<div class="delta">
				<Pill tone="down" label="zone not reporting" style="padding:1px 7px" />
			</div>
		{/if}
	</div>
	<div class="card stat emphasis">
		<div class="label">Avg latency · p50</div>
		<div class="value">
			{#if data.avgLatency == null}—{:else}{data.avgLatency}<small>ms</small>{/if}
		</div>
		<div class="delta mut">recent up checks</div>
	</div>
</div>

<!-- zones + open incident -->
<div class="grid grid-cols-1 lg:grid-cols-[1.15fr_0.85fr] gap-4">
	<div class="card">
		<div class="card__h">
			<h3>Zones</h3>
			<span class="hint"
				>{zones.length ? `${healthyZones}/${zones.length} healthy` : 'where checks run'}</span
			>
		</div>
		{#each zones as z, i (i)}
			<div class="zrow">
				<!-- Display name, with the code on hover: the code is what a user's
				     monitors are pinned to and what turns up in support threads. -->
				<b title={z.label !== z.zone ? z.zone : undefined}>{z.label ?? z.zone}</b>
				<Pill
					tone={z.healthy ? 'up' : 'down'}
					live={z.healthy}
					label={z.healthy ? 'Healthy' : 'Unhealthy'}
				/>
			</div>
		{/each}
		{#if zones.length === 0}
			<div class="mut" style="padding:16px;font-size:13px">No zones reporting yet.</div>
		{/if}
	</div>

	<div class="card">
		<div class="card__h">
			<h3>{openIncidents.length ? 'Open incidents' : 'Incidents'}</h3>
			<span class="hint">{openIncidents.length} active</span>
		</div>
		{#if openIncidents.length}
			{#each openIncidents.slice(0, 3) as inc (inc.id)}
				<div class="inc crit">
					<div class="stripe"></div>
					<div class="body">
						<div class="row1">
							<Pill tone="down" label="Down" />
							<h3>
								<a
									href={resolve('/incidents/[id]', { id: inc.id })}
									style="color:inherit;text-decoration:none">{inc.monitor}</a
								>
							</h3>
						</div>
						<p style="margin:9px 0 0;color:var(--ink-2);font-size:13px">
							{inc.cause || 'Investigating.'}
						</p>
						<div class="row2">
							<span><b>Started</b> {formatRelativeTime(inc.started_at)}</span>
						</div>
					</div>
				</div>
			{/each}
		{:else}
			<EmptyState card={false} message="No open incidents.">
				{#snippet icon()}
					<Pill tone="up" label="All clear" />
				{/snippet}
			</EmptyState>
		{/if}
	</div>
</div>

<!-- monitors -->
<div class="card">
	<div class="card__h">
		<h3>Monitors</h3>
		<span class="hint">{sc.total} total</span>
	</div>
	<div style="overflow-x:auto">
		<table class="data-table">
			<thead>
				<tr>
					<th>Name</th>
					<th>Status</th>
					<th class="r">p50</th>
					<th>Last 90m</th>
					<th class="r">Last check</th>
				</tr>
			</thead>
			<tbody>
				{#each monitors as m (m.id)}
					<tr>
						<td>
							<a
								href={resolve('/monitors/[id]', { id: m.id })}
								style="text-decoration:none;color:inherit;display:block"
							>
								<div class="m-name">{m.name}</div>
								<div class="m-url">{m.target}</div>
							</a>
						</td>
						<td><StatusBadge status={m.status} /></td>
						<td class="r val">{m.p50 == null ? '—' : formatMs(m.p50)}</td>
						<td>
							{#if m.sparkline && m.sparkline.length > 1}
								<Sparkline data={m.sparkline} tone={tone(m.status)} />
							{:else}
								<span class="mut val">—</span>
							{/if}
						</td>
						<td class="r val mut">{m.lastChecked ? formatRelativeTime(m.lastChecked) : '—'}</td>
					</tr>
				{/each}
				{#if monitors.length === 0}
					<tr>
						<td colspan="5" style="padding:16px">
							<a href={resolve('/monitors/new')}>Add your first monitor →</a>
						</td>
					</tr>
				{/if}
			</tbody>
		</table>
	</div>
</div>
