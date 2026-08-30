<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { usePoll } from '$lib/utils/use-poll';
	import { Meta, PageHeader, Pill, Sparkline } from '$lib/components/common';
	import { formatDuration, formatRelativeTime } from '$lib/utils/format-utils';

	let { data } = $props();
	let u = $derived(data.usage);
	let fleet = $derived(data.fleet ?? []);
	let checksSeries = $derived(u.activity.checksPerDay.map((d: any) => d.checks));
	let latestChecks = $derived(checksSeries.at(-1) ?? 0);
	let channelTypes = $derived(Object.entries(u.alerting.channelsByType) as [string, number][]);

	// A 1s ticker so the "Xs ago" heartbeats count up live between polls (relative
	// times are otherwise frozen at each render). The underlying timestamps refresh
	// on the poll below.
	let now = $state(Date.now());
	let ticker: ReturnType<typeof setInterval>;
	onMount(() => (ticker = setInterval(() => (now = Date.now()), 1000)));
	onDestroy(() => clearInterval(ticker));

	// The aggregate is cached ~60s server-side; poll re-pulls it and the fresh
	// fleet heartbeats.
	usePoll(() => invalidateAll(), 15000);
</script>

<Meta title="Usage · Admin" />

<PageHeader title="Usage" sub="Product usage at a glance — is nabz being used, and growing?" />

<section class="ausec">
	<span class="eyebrow">Users</span>
	<div class="stat-grid">
		<div class="card stat">
			<div class="label">Total users</div>
			<div class="value">{u.users.total}</div>
			<div class="delta mut">{u.users.verified} verified</div>
		</div>
		<div class="card stat">
			<div class="label">New · 7d</div>
			<div class="value">{u.users.newThisWeek}</div>
			<div class="delta mut">this week</div>
		</div>
		<div class="card stat">
			<div class="label">New · 30d</div>
			<div class="value">{u.users.newThisMonth}</div>
			<div class="delta mut">this month</div>
		</div>
		<div class="card stat">
			<div class="label">Active users</div>
			<div class="value">{u.activeUsers}</div>
			<div class="delta mut">≥1 enabled monitor</div>
		</div>
		<div class="card stat">
			<div class="label">With a channel</div>
			<div class="value">{u.usersWithChannel}</div>
			<div class="delta mut">set up alerting</div>
		</div>
	</div>
</section>

<section class="ausec">
	<span class="eyebrow">Monitors</span>
	<div class="stat-grid">
		<div class="card stat">
			<div class="label">Total monitors</div>
			<div class="value">{u.monitors.total}</div>
			<div class="delta mut">across all users</div>
		</div>
		<div class="card stat">
			<div class="label">Active</div>
			<div class="value">{u.monitors.active}</div>
			<div class="delta mut">enabled</div>
		</div>
		<div class="card stat">
			<div class="label">Paused</div>
			<div class="value">{u.monitors.paused}</div>
			<div class="delta mut">disabled</div>
		</div>
		<div class="card stat">
			<div class="label">New · 7d</div>
			<div class="value">{u.monitors.newThisWeek}</div>
			<div class="delta mut">this week</div>
		</div>
		<div class="card stat">
			<div class="label">Dependencies</div>
			<div class="value">{u.dependencies}</div>
			<div class="delta mut">links defined</div>
		</div>
	</div>
</section>

<section class="ausec">
	<span class="eyebrow">Activity</span>
	<div class="stat-grid">
		<div class="card stat emphasis">
			<div class="label">Checks · latest day</div>
			<div class="value">{latestChecks}</div>
			<div class="spark">
				{#if checksSeries.length > 1}<Sparkline
						data={checksSeries}
						tone="accent"
						width={160}
					/>{:else}<span class="delta mut">not enough history yet</span>{/if}
			</div>
		</div>
		<div class="card stat">
			<div class="label">Incidents · total</div>
			<div class="value">{u.activity.incidentsTotal}</div>
			<div class="delta mut">all time</div>
		</div>
		<div class="card stat">
			<div class="label">Incidents · 7d</div>
			<div class="value">{u.activity.incidentsThisWeek}</div>
			<div class="delta mut">this week</div>
		</div>
	</div>
</section>

<section class="ausec">
	<span class="eyebrow">Alerting</span>
	<div class="stat-grid">
		<div class="card stat">
			<div class="label">Channels configured</div>
			<div class="value">{u.alerting.channelsTotal}</div>
			<div class="delta mut">
				{channelTypes.map(([t, n]) => `${t} ${n}`).join(' · ') || 'none yet'}
			</div>
		</div>
		<div class="card stat">
			<div class="label">Escalation policies</div>
			<div class="value">{u.alerting.escalationPolicies}</div>
			<div class="delta mut">configured</div>
		</div>
		<div class="card stat">
			<div class="label">Test alerts</div>
			<div class="value">{u.alerting.testAlerts}</div>
			<div class="delta mut">people trying it out</div>
		</div>
		<div class="card stat">
			<div class="label">Alerts delivered · 90d</div>
			<div class="value">{u.alerting.delivered90d}</div>
			<div class="delta">
				{#if u.alerting.failed90d}<Pill
						tone="down"
						label={`${u.alerting.failed90d} failed`}
						style="padding:1px 7px"
					/>{:else}<span class="mut">no failures</span>{/if}
			</div>
		</div>
	</div>
</section>

<!-- Fleet operations — re-homed from the user dashboard (#248); admin-only ops detail. -->
<section class="ausec">
	<span class="eyebrow">Fleet operations</span>
	<div class="card" style="padding:0">
		<div style="overflow-x:auto">
			<table class="data-table">
				<thead>
					<tr
						><th>Node</th><th class="r">Workers</th><th class="r">Queue</th><th class="r">Lag</th><th
							>Leader</th
						><th class="r">Heartbeat</th
						><th>Health</th></tr
					>
				</thead>
				<tbody>
					{#each fleet as z, i (i)}
						<tr>
							<td
								><b>{z.zone}</b>{#if z.isEvaluator}<span class="mut" style="font-size:11px">
										· evaluator</span
									>{/if}</td
							>
							<td class="r val">{z.isEvaluator ? '—' : z.workers}</td>
							<td class="r val">{z.isEvaluator ? '—' : z.queueDepth}</td>
							<td class="r val">{z.isEvaluator ? '—' : formatDuration(z.scheduleLagSeconds)}</td>
							<td class="val mut" style="font-size:12px">{z.worker || '—'}</td>
							<td class="r val mut">{formatRelativeTime(z.updated, now)}</td>
							<td
								><Pill
									tone={z.healthy ? 'up' : 'down'}
									live={z.healthy}
									label={z.healthy ? 'Healthy' : 'Stale'}
								/></td
							>
						</tr>
					{/each}
					{#if fleet.length === 0}
						<tr
							><td colspan="6" class="mut" style="padding:16px;font-size:13px"
								>No nodes reporting yet.</td
							></tr
						>
					{/if}
				</tbody>
			</table>
		</div>
	</div>
</section>

<style>
	.ausec {
		margin-bottom: 22px;
	}
	.ausec .eyebrow {
		display: block;
		margin-bottom: 10px;
	}
	.stat-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
		gap: 14px;
	}
</style>
