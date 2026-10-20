<script lang="ts">
	// Mirrors routes/alerts/+page.svelte: the page holds the item in $state and
	// hands it to the form. Rendering the Form directly with a plain prop would
	// not reproduce how the real page wires it.
	import { AlertChannelNewItem } from '#lib/models/alert-channel.js';
	import { Form } from '../';

	// As the page does it: a plain copy of the model in $state.
	let newItem: AlertChannelNewItem | undefined = $state({
		...new AlertChannelNewItem({ type: 'webhook', enabled: true })
	});
</script>

<Form data={newItem} />
