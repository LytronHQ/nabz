<script lang="ts">
	// As routes/alerts/+page.svelte holds it, with the item exposed for assertions.
	import { AlertChannelNewItem } from '#lib/models/alert-channel.js';
	import { Form } from '../';

	let newItem: AlertChannelNewItem | undefined = $state({
		...new AlertChannelNewItem({ type: 'push', enabled: true })
	});
</script>

<Form data={newItem} />
<output data-testid="item">{JSON.stringify(newItem)}</output>
