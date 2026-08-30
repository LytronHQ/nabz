<script lang="ts">
	import { resolve } from '$app/paths';
	import { Meta } from '$lib/components/common';
	import { MonitorFormPage } from '$lib/components/monitors';
	import { MonitorNewItem } from '$lib/models/monitor';

	let { data } = $props();
	const item = new MonitorNewItem();
</script>

<Meta title="New monitor" />

<MonitorFormPage
	{item}
	availableZones={data.availableZones}
	availablePolicies={data.availablePolicies}
	title="New monitor"
	submitText="Add monitor"
	backHref={resolve('/monitors')}
/>
