<script lang="ts">
	interface Props {
		title?: string;
	}

	let { title = 'default title for page' }: Props = $props();
</script>

<svelte:head>
	<title>{title} | nabz</title>
</svelte:head>
