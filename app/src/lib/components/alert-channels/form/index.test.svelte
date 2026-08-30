<script lang="ts">
	import { AlertChannelNewItem } from '$lib/models/alert-channel';
	import { Form } from '../';

	const data = new AlertChannelNewItem({
		type: 'webhook',
		url: 'https://hooks.example.com/x',
		enabled: true
	});
</script>

<div data-testid="form">
	<Form {data} />
</div>
