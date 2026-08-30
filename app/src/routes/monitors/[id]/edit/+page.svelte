<script lang="ts">
	import { resolve } from '$app/paths';
	import { Meta } from '$lib/components/common';
	import { MonitorFormPage } from '$lib/components/monitors';
	import { MonitorItem } from '$lib/models/monitor';

	let { data } = $props();
	// Derived, not captured: SvelteKit reuses this component when navigating from
	// one monitor's edit page to another, so `data` changes without a remount. A
	// `const` read at init showed the previous monitor's values in the form.
	let item = $derived(new MonitorItem(data.monitor));
</script>

<Meta title={`Edit ${data.monitor.name}`} />

<MonitorFormPage
	{item}
	availableZones={data.availableZones}
	availablePolicies={data.availablePolicies}
	title={`Edit ${data.monitor.name}`}
	submitText="Save changes"
	backHref={resolve('/monitors/[id]', { id: data.monitor.id! })}
/>
