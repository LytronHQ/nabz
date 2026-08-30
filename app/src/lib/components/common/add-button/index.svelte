<script lang="ts">
	// The primary "Add …" action, with the inline plus glyph (#166). Renders a link
	// when `href` is set (navigates) or a button otherwise (calls `onclick`, for
	// modal openers). Styling is the global `.btn`/`.btn-primary` — no styles here.
	import { Icon } from '../icon';

	interface Props {
		label: string;
		href?: string | undefined;
		onclick?: (e: MouseEvent) => void;
	}

	let { label, href = undefined, onclick = undefined }: Props = $props();
</script>

{#if href}
	<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- href is a prop; every caller passes a resolve()d path -->
	<a class="btn btn-primary" {href} {onclick}>
		<Icon name="plus" />
		{label}
	</a>
{:else}
	<button type="button" class="btn btn-primary" {onclick}>
		<Icon name="plus" />
		{label}
	</button>
{/if}
