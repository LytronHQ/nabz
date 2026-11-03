<script lang="ts">
	import { resolve } from '$app/paths';
	import { Alert, Meta } from '#lib/components/common/index.js';
	import { MonitorFormPage } from '#lib/components/monitors/index.js';
	import { page } from '$app/state';
	import { MonitorNewItem, isSupportedMonitorType, type MonitorType } from '#lib/models/monitor.js';
	import { monitorLimitMessage, PLANS } from '#lib/plans.js';

	let { data } = $props();
	const item = new MonitorNewItem();
	// Start at the fastest interval the plan allows (#678): the default 60 s would
	// be refused on Free the moment it is saved.
	// svelte-ignore state_referenced_locally
	item.interval = Math.max(item.interval, data.plan.minIntervalSeconds);
	// A free tool's "watch this" link (#684) prefills the type and the target.
	const prefill = page.url.searchParams;
	if (isSupportedMonitorType(prefill.get('type') ?? ''))
		item.type = prefill.get('type') as MonitorType;
	if (prefill.get('target')) item.target = prefill.get('target')!.slice(0, 2048);
	let atLimit = $derived(
		data.plan.monitors !== null && data.plan.monitors >= data.plan.monitorLimit
	);
</script>

<Meta title="New monitor" />

{#if atLimit}
	<div class="plan-full">
		<Alert tone="info">
			{monitorLimitMessage(PLANS[data.plan.planId])}
			<a class="plan-full__link" href={resolve('/account')}>See your plan</a>
		</Alert>
	</div>
{/if}

<MonitorFormPage
	{item}
	minInterval={data.plan.minIntervalSeconds}
	planName={data.plan.planName}
	availableZones={data.availableZones}
	availablePolicies={data.availablePolicies}
	title="New monitor"
	submitText="Add monitor"
	backHref={resolve('monitors')}
/>

<style>
	.plan-full {
		margin-bottom: 14px;
	}
	.plan-full__link {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
		white-space: nowrap;
	}
</style>
