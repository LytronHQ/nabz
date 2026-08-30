<script lang="ts">
	import { MonitorItem, MonitorNewItem } from '$lib/models/monitor';
	import { Form } from '../';

	const newData = new MonitorNewItem({
		name: 'New Website',
		type: 'website',
		target: 'https://new.example.com',
		interval: 60,
		enabled: true
	});

	const editData = new MonitorItem({
		id: 'abc123',
		name: 'Edit Website',
		type: 'website',
		target: 'https://edit.example.com',
		interval: 120,
		enabled: true
	});
</script>

<div data-testid="new-data">
	<Form
		data={newData}
		availableZones={[
			{ zone: 'eu', stale: false },
			{ zone: 'us', stale: true }
		]}
	/>
</div>

<div data-testid="edit-data">
	<Form data={editData} />
</div>
