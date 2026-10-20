<script lang="ts">
	import { Meta, PageHeader } from '#lib/components/common/index.js';
	import { MonitorMap, ViewTabs } from '#lib/components/monitors/index.js';

	let { data } = $props();
	let mode: 'tag' | 'domain' = $state('tag');
</script>

<Meta title="Monitor map" />

<PageHeader
	title="Monitor map"
	sub={`${data.monitors.length} monitor${data.monitors.length === 1 ? '' : 's'} · grouped by ${mode}`}
>
	{#snippet actions()}
		<div class="seg">
			<button class:on={mode === 'tag'} aria-pressed={mode === 'tag'} onclick={() => (mode = 'tag')}
				>By tag</button
			>
			<button
				class:on={mode === 'domain'}
				aria-pressed={mode === 'domain'}
				onclick={() => (mode = 'domain')}>By domain</button
			>
		</div>
	{/snippet}
</PageHeader>

<ViewTabs />

<MonitorMap monitors={data.monitors} {mode} />
