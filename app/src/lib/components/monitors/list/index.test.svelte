<script lang="ts">
	import type { MonitorItem } from '$lib/models/monitor';
	import { List } from '../';

	const data = [
		{
			id: '1',
			name: 'Monitor One',
			type: 'website',
			status: 'up',
			uptime24h: 99.9,
			lastChecked: null,
			lastDowntime: new Date(Date.now() - 3 * 86400000).toISOString()
		},
		{
			id: '2',
			name: 'Monitor Two',
			type: 'ping',
			status: 'down',
			uptime24h: null,
			lastChecked: null,
			lastDowntime: null
		}
	] as unknown as MonitorItem[];
</script>

<div data-testid="list-data">
	<List {data} />
</div>
