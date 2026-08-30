<script lang="ts">
	import type { AlertChannelItem } from '$lib/models/alert-channel';
	import { List } from '../';

	const data = [
		{
			id: '1',
			type: 'webhook',
			name: 'Prod Slack',
			url: 'https://hooks.example.com/x',
			enabled: true
		},
		{ id: '2', type: 'email', name: '', email: 'a@b.com', enabled: false }
	] as unknown as AlertChannelItem[];
</script>

<div data-testid="list">
	<List {data} />
</div>
