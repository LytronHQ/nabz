<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		title?: string;
	}

	let { title = 'default title for page' }: Props = $props();

	// An installed app's window puts the app name in front of the page title
	// itself, which made "nabz - Dashboard | nabz". In a browser tab the suffix
	// still says which site the tab is.
	let installed = $state(false);
	onMount(() => {
		installed = ['standalone', 'window-controls-overlay', 'minimal-ui'].some(
			(mode) => window.matchMedia?.(`(display-mode: ${mode})`).matches
		);
	});
</script>

<svelte:head>
	<title>{installed ? title : `${title} | nabz`}</title>
</svelte:head>
