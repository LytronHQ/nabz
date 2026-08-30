<script lang="ts">
	import { resolve } from '$app/paths';

	import { invalidateAll, goto } from '$app/navigation';
	import { usePoll } from '$lib/utils/use-poll';
	import { latestPerZone } from '$lib/utils/latest-per-zone';
	import { page } from '$app/stores';
	import { Icon, Meta, StatusBadge, Pagination } from '$lib/components/common';
	import { monitorFilters } from '$lib/stores/list-filters';
	import { ResponseTimeChart, AvailabilityCard } from '$lib/components/monitors';
	import { MonitorItem } from '$lib/models/monitor';
	import { PaginationData } from '$lib/models';
	import MonitorsStore from '$lib/stores/monitors-store';
	import type ApiError from '$lib/models/api-error';
	import {
		formatUptime,
		formatRelativeTime,
		formatMs,
		checkState,
		isInMaintenance,
		formatNextCheck
	} from '$lib/utils/format-utils';
	import { pushToast } from '$lib/stores/toast-store';
	import { friendlyMessage } from '$lib/utils/api-error-utils';

	let { data } = $props();

	let now = $state(Date.now());

	// Heartbeat check-in URL (the public /ping/{token} the user's cron hits).
	let copied = $state(false);
	async function copyCheckin() {
		try {
			if (navigator.clipboard && window.isSecureContext) {
				await navigator.clipboard.writeText(checkinUrl);
			} else {
				// The Clipboard API only exists in a secure context (HTTPS/localhost).
				// Over plain HTTP (self-hosted, dev) fall back to a temporary selection.
				const ta = document.createElement('textarea');
				ta.value = checkinUrl;
				ta.setAttribute('readonly', '');
				ta.style.position = 'fixed';
				ta.style.opacity = '0';
				document.body.appendChild(ta);
				ta.select();
				const ok = document.execCommand('copy');
				document.body.removeChild(ta);
				if (!ok) throw new Error('copy command rejected');
			}
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			pushToast('error', 'Could not copy — select the URL and copy it manually');
		}
	}

	// Recent-checks table pages client-side over the loaded window (the chart keeps
	// the full window); newest first.
	const recentPageSize = 15;
	let checksPage = $state(1);

	// A redirect's final URL can be enormous (e.g. an auth gateway with a big
	// token query). Show host + path only (the query is the noisy part) so the
	// Recent-checks ERROR cell stays readable; the full URL is kept in the cell's
	// title, and the ↪N indicator's tooltip also carries it.
	function shortUrl(u: string): string {
		try {
			const { host, pathname } = new URL(u);
			return host + (pathname === '/' ? '' : pathname);
		} catch {
			return u;
		}
	}

	// p95 of up-check response times, over any set of checks
	function p95Of(arr: any[]): number | null {
		const ups = arr
			.filter((c) => c.up && c.response_ms != null)
			.map((c) => c.response_ms as number);
		if (!ups.length) return null;
		ups.sort((a, b) => a - b);
		return ups[Math.min(ups.length - 1, Math.floor(ups.length * 0.95))];
	}

	let selectedZone = $state('all');

	// --- time range: Hour/Day render raw checks (phase chart); Week/Month render
	// rollup averages (no phase data), fetched on demand. ---
	type Range = 'hour' | 'day' | 'week' | 'month';
	let range = $state<Range>('day');
	let chartMode: 'phases' | 'avg' = $derived(
		range === 'week' || range === 'month' ? 'avg' : 'phases'
	);

	let seriesPoints: any[] = $state([]);
	let seriesKey = '';
	async function loadSeries(r: Range, zone: string) {
		const key = `${r}:${zone}`;
		if (key === seriesKey) return;
		seriesKey = key;
		try {
			const res = await fetch(`/api/monitors/${monitor.id}/series?range=${r}&zone=${zone}`);
			seriesPoints = res.ok ? ((await res.json()).points ?? []) : [];
		} catch {
			seriesPoints = [];
		}
	}

	// --- pause / resume ---
	let pausing = $state(false);

	const store = new MonitorsStore();
	let lastError: ApiError | null = null;
	store.subscribeError((e) => (lastError = e));

	async function togglePause() {
		enabled = !enabled; // optimistic: button + badge flip immediately
		pausing = true;
		const item = new MonitorItem(data.monitor);
		item.enabled = enabled;
		const ok = await store.edit(item);
		pausing = false;
		if (ok) {
			pushToast('success', enabled ? 'Monitor resumed' : 'Monitor paused');
			invalidateAll(); // reconcile status/checks in the background
		} else {
			enabled = !enabled; // revert on failure
			pushToast('error', friendlyMessage(lastError));
		}
	}
	function formatDurationMs(ms: number): string {
		const total = Math.floor(ms / 1000);
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		const s = total % 60;
		if (h) return `${h}h ${m}m ${s}s`;
		if (m) return `${m}m ${s}s`;
		return `${s}s`;
	}
	const fmtPct = (v: number | null) => (v == null ? '—' : `${v}%`);

	// --- availability: custom From/To range calculator ---
	const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
	let fromDate = $state(isoDay(Date.now() - 14 * 86_400_000));
	let toDate = $state(isoDay(Date.now()));
	let customStat: (typeof data.availability)[number] | null = $state(null);
	let calcLoading = $state(false);
	let calcError = $state('');
	async function calcCustom() {
		calcError = '';
		if (!fromDate || !toDate) {
			calcError = 'Pick both dates';
			return;
		}
		calcLoading = true;
		try {
			const res = await fetch(
				`/api/monitors/${monitor.id}/availability?from=${fromDate}&to=${toDate}`
			);
			if (res.ok) {
				customStat = await res.json();
			} else {
				const e = await res.json().catch(() => ({}));
				calcError = e.error ?? 'Failed to calculate';
				customStat = null;
			}
		} catch {
			calcError = 'Failed to calculate';
		}
		calcLoading = false;
	}

	// Revalidate immediately (immediate: true): if we arrived on a stale (e.g.
	// hover-preloaded) snapshot, refresh it now rather than waiting for the first
	// 10s tick (#134). The 1s tick advances the live "now"-based durations.
	usePoll(() => invalidateAll(), 10000, { immediate: true });
	usePoll(() => (now = Date.now()), 1000);
	function goToTag(tag: string) {
		// Jump to the Monitors list filtered by this tag (#142) — set the persisted
		// filter (a #tag search) and navigate; the Monitors page restores it on mount.
		monitorFilters.set({ q: `#${tag}`, status: '' });
		goto(resolve('/monitors'));
	}
	let monitor = $derived(data.monitor);
	// The p95 the evaluator alerts on (#404). Already on the loaded monitor — the
	// server returns a spread MonitorItem, which normalises it out of the nested
	// `config` JSON — so this needs no extra fetch, and it is the same field the
	// summary line below already reads. 0/null means slowness alerting is off,
	// which the chart treats as "draw nothing".
	let latencyThresholdMs = $derived(monitor.latencyThresholdMs ?? 0);
	let checkinUrl = $derived(monitor?.token ? `${$page.url.origin}/ping/${monitor.token}` : '');
	let checks = $derived(data.checks ?? []);
	// `enabled` is local + optimistic so Pause/Resume flips instantly instead of
	// waiting on the server loader (which also refetches checks). The reactive
	// assignment re-syncs it whenever the loader reloads.
	let enabled = $derived(data.monitor.enabled);
	let displayStatus = $derived(
		enabled ? (monitor.status === 'paused' ? 'pending' : monitor.status) : 'paused'
	);
	// Live "currently down for" — only while down with an open (unresolved) incident.
	// `now` ticks every second (see onMount) so the duration counts up on screen.
	let downFor = $derived(
		data.openIncident && displayStatus === 'down'
			? Math.max(0, now - new Date(data.openIncident.started_at).getTime())
			: null
	);
	let checksNewest = $derived([...checks].reverse());
	$effect(() => {
		if (checksNewest.length && checksPage > Math.ceil(checksNewest.length / recentPageSize))
			checksPage = 1;
	});
	let recent = $derived(
		checksNewest.slice((checksPage - 1) * recentPageSize, checksPage * recentPageSize)
	);
	let checksPagination = $derived(
		new PaginationData({
			current: checksPage,
			size: recentPageSize,
			totalItems: checksNewest.length
		} as any)
	);
	let latest = $derived(checks.length ? checks[checks.length - 1] : null);
	let inMaint = $derived(isInMaintenance(monitor.maintenanceWindows, now));
	// Non-default HTTP options, summarised for display.
	let httpOpts = $derived(
		(() => {
			const parts: string[] = [];
			if (monitor.method && monitor.method !== 'GET') parts.push(monitor.method);
			if (monitor.expectedStatus) parts.push(`expects ${monitor.expectedStatus}`);
			if (monitor.followRedirects === false) parts.push("doesn't follow redirects");
			if (monitor.timeoutSecs) parts.push(`${monitor.timeoutSecs}s timeout`);
			if (monitor.latencyThresholdMs) parts.push(`slow-alert > ${monitor.latencyThresholdMs}ms`);
			const hc = (monitor.headers ?? '').split('\n').filter((l: string) => l.includes(':')).length;
			if (hc) parts.push(`${hc} custom header${hc === 1 ? '' : 's'}`);
			return parts;
		})()
	);
	// TLS certificate expiry (HTTPS website monitors only; captured by the worker).
	let certExpiry = $derived(monitor.certExpiresAt ? new Date(monitor.certExpiresAt) : null);
	let certDays = $derived(
		certExpiry && !Number.isNaN(certExpiry.getTime())
			? Math.floor((certExpiry.getTime() - now) / 86_400_000)
			: null
	);
	// Domain registration expiry — an infrequent, cached RDAP/WHOIS lookup the
	// evaluator runs (distinct from the TLS cert above). Warns further out (30d)
	// since domains renew yearly and lapsing loses the name entirely.
	let domainExpiry = $derived(monitor.domainExpiresAt ? new Date(monitor.domainExpiresAt) : null);
	let domainDays = $derived(
		domainExpiry && !Number.isNaN(domainExpiry.getTime())
			? Math.floor((domainExpiry.getTime() - now) / 86_400_000)
			: null
	);
	// Numeric summary-strip cells present (Uptime + Interval always; Response only
	// for probed types). Drives the mobile row's column count so those cells share
	// one row with no empty track; SSL/Domain reflow to their own full-width rows.
	let numericCols = $derived(monitor.type === 'heartbeat' ? 2 : 3);
	// latest check per zone (checks are oldest-first, so the last one wins)
	// One card per zone the evaluator VOTED WITH, not per zone that happens to have
	// a check row (#328). A zone with no live worker used to vanish from this list,
	// so two assigned zones showing one card looked exactly like a healthy
	// single-zone monitor — the user believed they had cross-zone confirmation and
	// did not.
	type ZoneCheck = {
		zone: string;
		up?: boolean;
		response_ms?: number | null;
		status_code?: number | null;
		checked_at: string;
	};
	type ZoneCard = { zone: string; check?: ZoneCheck; voting: boolean };

	// Newest per zone (#406) — see latestPerZone for why it compares timestamps
	// rather than trusting the order of `checks`.
	let latestByZone = $derived(latestPerZone(checks as ZoneCheck[]));
	// Prefer what the evaluator recorded; fall back to observed zones for a monitor
	// that has never been evaluated, or one that runs everywhere.
	let participatingZones = $derived(
		monitor.consensusZones.length
			? monitor.consensusZones
			: monitor.zones.length
				? monitor.zones
				: [...new Set((checks as ZoneCheck[]).map((c) => c.zone).filter(Boolean))].sort()
	);
	let byZone: ZoneCard[] = $derived(
		participatingZones.map((zone: string) => ({
			zone,
			check: latestByZone[zone],
			// "Voting" is the evaluator's own answer, not ours. Before it has
			// recorded anything, fall back to "we have a check for it".
			voting: monitor.consensusFresh.length
				? monitor.consensusFresh.includes(zone)
				: !!latestByZone[zone]
		}))
	);
	// The consequence, spelled out. Saying "1 of 2 zones" without saying what
	// changed leaves the reader to know the consensus rules by heart.
	let consensusNote = $derived.by(() => {
		const total = participatingZones.length;
		const voting = byZone.filter((z) => z.voting).map((z) => z.zone);
		const missing = byZone.filter((z) => !z.voting).map((z) => z.zone);
		if (total < 2 || missing.length === 0) return null;
		if (voting.length === 0) {
			return `No assigned zone has reported recently (${missing.join(', ')}), so this monitor is not being checked and its status is frozen.`;
		}
		if (voting.length === 1) {
			return `Consensus is using 1 of ${total} assigned zones — ${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no recent checks. Down now requires consecutive failures from ${voting[0]} alone, instead of agreement between zones.`;
		}
		return `Consensus is using ${voting.length} of ${total} assigned zones — ${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no recent checks.`;
	});
	let p95 = $derived(p95Of(checks));
	// --- region selector: filters the chart by zone ---
	let zones = $derived([...new Set(checks.map((c: any) => c.zone).filter(Boolean))].sort());
	// if the selected zone drops out of the window on refresh, fall back to all
	$effect(() => {
		if (selectedZone !== 'all' && !zones.includes(selectedZone)) selectedZone = 'all';
	});
	let zoneChecks = $derived(
		selectedZone === 'all' ? checks : checks.filter((c: any) => c.zone === selectedZone)
	);
	$effect(() => {
		if (range === 'week' || range === 'month') loadSeries(range, selectedZone);
	});
	let displayChecks = $derived(
		range === 'hour'
			? zoneChecks.filter((c: any) => new Date(c.checked_at).getTime() >= Date.now() - 3_600_000)
			: range === 'day'
				? zoneChecks
				: seriesPoints
	);
	// Live "next check in …" estimate (#122): the worker's per-zone due queue fires
	// ~every interval after the last check. Reuses the 1s `now` ticker (no new timer);
	// the 10s invalidate advances lastChecked shortly after a real check lands, so the
	// countdown resets. It's an estimate — a rate-limited target can push it later.
	let nextCheckLabel = $derived(
		formatNextCheck(enabled, monitor.lastChecked, monitor.interval, now)
	);
</script>

<Meta title={monitor.name} />

<div class="crumb"><a href={resolve('/monitors')}>← Monitors</a></div>

<div class="detail-head">
	<h1>{monitor.name}</h1>
	<StatusBadge status={displayStatus} />
	{#if inMaint}<StatusBadge status="maintenance" />{/if}
	<div class="toolbar" style="margin-left:auto">
		<button type="button" class="btn btn-ghost" onclick={togglePause} disabled={pausing}>
			{#if enabled}
				<Icon name="pause" />
				Pause
			{:else}
				<Icon name="play" />
				Resume
			{/if}
		</button>
		<a class="btn btn-ghost" href={resolve('/monitors/[id]/edit', { id: data.monitor.id! })}>
			<Icon name="edit" />
			Edit
		</a>
	</div>
</div>
{#if monitor.tags?.length}
	<div class="detail-tags">
		{#each monitor.tags as t (t)}
			<button
				type="button"
				class="detail-tag"
				onclick={() => goToTag(t)}
				title="Filter monitors by {t}">#{t}</button
			>
		{/each}
	</div>
{/if}
<div class="mono" style="color:var(--ink-3);font-size:12.5px">
	{#if monitor.type === 'heartbeat'}
		heartbeat · expects a check-in every {monitor.interval}s
	{:else}
		{monitor.type} · {monitor.target} · every {monitor.interval}s · zones: {monitor.zones?.length
			? monitor.zones.join(', ')
			: 'all'}
	{/if}
</div>
{#if monitor.type === 'heartbeat' && checkinUrl}
	<div class="card hb-checkin">
		<div class="label">Check-in URL</div>
		<div class="hb-row">
			<code class="hb-url">{checkinUrl}</code>
			<button type="button" class="btn btn-ghost" onclick={copyCheckin}
				>{copied ? 'Copied' : 'Copy'}</button
			>
		</div>
		<p class="mut" style="font-size:12px;margin-top:6px">
			Have your job request this each run — e.g. <code>curl -fsS {checkinUrl}</code>. No check-in
			within the interval (plus a short grace) opens an incident.
		</p>
	</div>
{/if}
<!-- Summary strip (#210): the fixed facts as one dense datasheet row — cells
     divided by 1px hairlines. Replaces the old SSL + domain cards and the four
     stat tiles. Desktop: N equal cells in a row. Mobile: the numeric cells share
     one row of `--num-cols`; SSL + Domain each reflow to their own full-width
     row. SSL/Domain carry a left-accent status border (green valid / red soon). -->
<div class="summary" style="--num-cols:{numericCols}">
	<div class="scell">
		<div class="scell-label">Uptime · 24h</div>
		<div class="scell-val">{formatUptime(monitor.uptime24h)}</div>
		{#if downFor != null}
			<div class="scell-sub down-txt">down {formatDurationMs(downFor)}</div>
		{:else}
			<div class="scell-sub">
				{monitor.lastChecked
					? `checked ${formatRelativeTime(monitor.lastChecked)}`
					: 'no checks yet'}
			</div>
		{/if}
	</div>
	{#if monitor.type !== 'heartbeat'}
		<div class="scell">
			<div class="scell-label">Response</div>
			<div class="scell-val">
				{#if latest?.response_ms == null}—{:else}{latest.response_ms}<small>ms</small>{/if}
			</div>
			<div class="scell-sub">p95 {p95 == null ? '—' : formatMs(p95)}</div>
		</div>
	{/if}
	<div class="scell">
		<div class="scell-label">Interval</div>
		<div class="scell-val">{monitor.interval}<small>s</small></div>
		{#if monitor.type !== 'heartbeat'}<div class="scell-sub">{nextCheckLabel}</div>{/if}
	</div>
	{#if certDays != null}
		<div class="scell accent" class:warn={certDays <= 14}>
			<div class="scell-label">SSL / TLS</div>
			<div class="scell-val">
				{certExpiry?.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}
			</div>
			<div class="scell-sub" class:down-txt={certDays <= 14}>
				{certDays < 0 ? 'expired' : `${certDays}d left`}
			</div>
		</div>
	{/if}
	{#if domainDays != null}
		<div class="scell accent" class:warn={domainDays <= 30}>
			<div class="scell-label">Domain</div>
			<div class="scell-val">
				{domainExpiry?.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}
			</div>
			<div class="scell-sub" class:down-txt={domainDays <= 30}>
				{domainDays < 0 ? 'expired' : `${domainDays}d left`}
			</div>
		</div>
	{/if}
</div>
{#if monitor.keywordMode === 'contains' || monitor.keywordMode === 'absent'}
	<div class="mono mut" style="font-size:12.5px;margin-top:4px">
		Body must {monitor.keywordMode === 'absent' ? 'not contain' : 'contain'} "{monitor.keyword}"
	</div>
{/if}
{#if httpOpts.length}
	<div class="mono mut" style="font-size:12.5px;margin-top:4px">{httpOpts.join(' · ')}</div>
{/if}

<!-- availability overview — general health first (at-a-glance uptime bar + key
     figures), above the phase chart's technical detail. Shown for every type. -->
<AvailabilityCard ranges={data.availabilityOverview} />

<!-- response time chart (not meaningful for a heartbeat check-in) -->
{#if monitor.type !== 'heartbeat'}
	<div class="card chartcard">
		<div class="chart-legend">
			<span class="t">
				{chartMode === 'avg' ? 'Avg response time' : 'Response time by phase'}
				<select class="zone-select" bind:value={selectedZone} aria-label="Region">
					<option value="all">All zones</option>
					{#each zones as z (z)}<option value={z}>{z}</option>{/each}
				</select>
			</span>
			<div class="seg">
				<button class:on={range === 'hour'} onclick={() => (range = 'hour')}>Hour</button>
				<button class:on={range === 'day'} onclick={() => (range = 'day')}>Day</button>
				<button class:on={range === 'week'} onclick={() => (range = 'week')}>Week</button>
				<button class:on={range === 'month'} onclick={() => (range = 'month')}>Month</button>
			</div>
		</div>
		<ResponseTimeChart checks={displayChecks} mode={chartMode} {latencyThresholdMs} />
	</div>
{/if}

<!-- by zone -->
{#if byZone.length > 0 && monitor.type !== 'heartbeat'}
	<div>
		<div class="card__h" style="border:0;padding:2px 2px 10px">
			<h3>By zone</h3>
			<span class="hint">latest check per assigned zone</span>
		</div>
		{#if consensusNote}
			<div class="consensus-note" role="status">{consensusNote}</div>
		{/if}
		<div class="zone-cards">
			{#each byZone as z (z.zone)}
				<!-- Two separate facts, deliberately not conflated: `voting` is the
				     evaluator's own answer about whether this zone counted toward the
				     verdict, while `check` is merely whether we loaded a row to show. A
				     zone can vote with a check older than this page's window. -->
				<div class="card zc" class:silent={!z.voting}>
					<div class="top">
						<b>{z.zone}</b>
						{#if z.voting && z.check}
							<StatusBadge status={checkState(z.check)} />
						{:else}
							<span class="no-data">no data</span>
						{/if}
					</div>
					<div class="lat">
						{#if z.voting && z.check && z.check.response_ms != null}
							{z.check.response_ms}<small style="font-size:13px;color:var(--ink-3)">ms</small>
						{:else}—{/if}
					</div>
					<div class="meta">
						{#if z.voting && z.check}
							{formatRelativeTime(z.check.checked_at)} · {z.check.status_code ||
								(z.check.up ? '200' : 'error')}
						{:else if z.check}
							last seen {formatRelativeTime(z.check.checked_at)} · too old to count
						{:else}
							no live worker in this zone
						{/if}
					</div>
				</div>
			{/each}
		</div>
	</div>
{/if}

<!-- availability -->
<div class="card">
	<div class="card__h">
		<h3>Availability</h3>
		<span class="hint">uptime from rollups · downtime from incidents</span>
	</div>
	<div style="overflow-x:auto">
		<table class="data-table">
			<thead>
				<tr>
					<th>Period</th>
					<th class="r">Availability</th>
					<th class="r">Downtime</th>
					<th class="r">Incidents</th>
					<th class="r">Longest</th>
					<th class="r">Avg incident</th>
				</tr>
			</thead>
			<tbody>
				{#each data.availability as row, i (i)}
					<tr>
						<td>{row.label}</td>
						<td class="r val">{fmtPct(row.availability)}</td>
						<td class="r val">{row.downtimeMs ? formatDurationMs(row.downtimeMs) : '—'}</td>
						<td class="r val">{row.incidents}</td>
						<td class="r val">{row.longestMs ? formatDurationMs(row.longestMs) : '—'}</td>
						<td class="r val">{row.avgMs ? formatDurationMs(row.avgMs) : '—'}</td>
					</tr>
				{/each}
				{#if customStat}
					<tr class="custom-row">
						<td
							><b>Custom</b>
							<span class="mut" style="font-size:12px">{fromDate} → {toDate}</span></td
						>
						<td class="r val">{fmtPct(customStat.availability)}</td>
						<td class="r val"
							>{customStat.downtimeMs ? formatDurationMs(customStat.downtimeMs) : '—'}</td
						>
						<td class="r val">{customStat.incidents}</td>
						<td class="r val"
							>{customStat.longestMs ? formatDurationMs(customStat.longestMs) : '—'}</td
						>
						<td class="r val">{customStat.avgMs ? formatDurationMs(customStat.avgMs) : '—'}</td>
					</tr>
				{/if}
			</tbody>
		</table>
	</div>
	<div class="calc">
		<label>From <input type="date" bind:value={fromDate} max={toDate} /></label>
		<label>To <input type="date" bind:value={toDate} /></label>
		<button type="button" class="btn btn-ghost" onclick={calcCustom} disabled={calcLoading}>
			{calcLoading ? 'Calculating…' : 'Calculate'}
		</button>
		{#if calcError}<span class="down-txt" style="font-size:12.5px">{calcError}</span>{/if}
	</div>
</div>

<!-- recent checks -->
<div class="card">
	<div class="card__h">
		<h3>Recent checks</h3>
		<span class="hint">newest first</span>
	</div>
	<div style="overflow-x:auto">
		<table class="data-table">
			<thead>
				<tr>
					<th>Time</th>
					<th>Zone</th>
					<th>Result</th>
					<th class="r">Code</th>
					<th class="r">Response</th>
					<th>Error</th>
				</tr>
			</thead>
			<tbody>
				{#each recent as c, i (i)}
					<tr>
						<td class="val mut">{formatRelativeTime(c.checked_at)}</td>
						<td><span class="zone-tag">{c.zone}</span></td>
						<td><StatusBadge status={checkState(c)} /></td>
						<td class="r val"
							>{c.status_code || '—'}{#if c.redirect_count}<span
									class="redir"
									title="Followed {c.redirect_count} redirect{c.redirect_count === 1
										? ''
										: 's'} → {c.final_url}">&nbsp;↪{c.redirect_count}</span
								>{/if}</td
						>
						<td class="r val">{formatMs(c.response_ms)}</td>
						<td class={checkState(c) === 'down' ? 'down-txt' : 'mut'} style="font-size:12px">
							{#if c.error}
								<span class="err-cell" title={c.error}>{c.error}</span>
							{:else if c.redirect_count}
								<span class="err-cell" title={`→ ${c.final_url}`}>→ {shortUrl(c.final_url)}</span>
							{/if}
						</td>
					</tr>
				{/each}
				{#if recent.length === 0}
					<tr><td colspan="6" class="mut" style="padding:16px">No checks yet.</td></tr>
				{/if}
			</tbody>
		</table>
	</div>
	{#if checksPagination.isVisible}
		<div style="padding: 2px 16px 12px">
			<Pagination data={checksPagination} onupdate={(d) => (checksPage = d.page)} />
		</div>
	{/if}
</div>

<style>
	/* Summary strip (#210). 1px hairlines come from the gap showing the container's
	   border-colour background (datasheet look); every cell fills its track so no
	   gap reads as an empty block. Mobile: numeric cells share a `--num-cols` row,
	   SSL/Domain span full-width; desktop: one equal column per cell. */
	.summary {
		display: grid;
		grid-template-columns: repeat(var(--num-cols, 3), 1fr);
		gap: 1px;
		background: var(--border);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.scell {
		background: var(--surface-1);
		padding: 11px 14px;
		min-width: 0;
	}
	.scell.accent {
		border-left: 2px solid var(--status-up);
		/* SSL + Domain: own full-width row on mobile, laid out horizontally so the
		   big date fills the right-hand space — label + days-left on the left. */
		grid-column: 1 / -1;
		display: grid;
		grid-template-columns: 1fr auto;
		grid-template-areas: 'label date' 'sub date';
		align-items: center;
		column-gap: 12px;
	}
	.scell.accent .scell-label {
		grid-area: label;
	}
	.scell.accent .scell-sub {
		grid-area: sub;
	}
	.scell.accent .scell-val {
		grid-area: date;
		font-size: 26px; /* big date, using the width on mobile */
	}
	.scell.accent.warn {
		border-left-color: var(--status-down);
	}
	.scell-label {
		text-transform: uppercase;
		font-size: 10.5px;
		letter-spacing: 0.08em;
		color: var(--text-muted);
	}
	.scell-val {
		font-family: var(--font-stat);
		font-variant-numeric: tabular-nums;
		font-size: 20px;
		line-height: 1.15;
		margin-top: 3px;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.scell-val small {
		font-size: 13px;
		color: var(--text-muted);
		margin-left: 1px;
	}
	.scell-sub {
		font-size: 11.5px;
		color: var(--text-muted);
		margin-top: 3px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	@media (min-width: 768px) {
		.summary {
			grid-auto-flow: column;
			grid-auto-columns: 1fr;
			grid-template-columns: none;
		}
		.scell.accent {
			grid-column: auto; /* back to a single equal cell in the row */
			display: block; /* vertical stack like the other cells */
		}
		.scell.accent .scell-val {
			font-size: 20px; /* still the prominent (big) date, sized like the others */
		}
	}
	.redir {
		color: var(--ink-3);
		font-size: 11px;
		font-weight: 500;
	}
	/* Clamp the ERROR cell to one line so a pathological value (a huge redirect
	   URL) can't blow out the row height; the full text lives in the title. */
	.err-cell {
		display: block;
		max-width: 340px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.detail-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 10px;
	}
	.detail-tag {
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: var(--ink-2);
		border-radius: var(--radius-btn);
		padding: 2px 9px;
		font-size: 12px;
		cursor: pointer;
	}
	.detail-tag:hover {
		border-color: var(--border-strong);
		color: var(--ink);
	}
	.hb-checkin {
		margin-top: 12px;
		padding: 14px 16px;
	}
	.hb-checkin .label {
		font-size: 12px;
		color: var(--ink-3);
		margin-bottom: 6px;
	}
	.hb-row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.hb-url {
		flex: 1 1 auto;
		min-width: 0;
		overflow-x: auto;
		white-space: nowrap;
		padding: 8px 10px;
		border-radius: var(--radius-btn);
		background: var(--surface-2);
		border: 1px solid var(--border);
		font-size: 13px;
	}
	.calc {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		padding: 12px 16px 14px;
		font-size: 13px;
		color: var(--ink-2);
	}
	.calc label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.calc input[type='date'] {
		font-family: inherit;
		font-size: 12.5px;
		color: var(--ink);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		padding: 4px 8px;
	}
	.custom-row {
		border-top: 2px solid var(--border-strong);
	}
</style>
