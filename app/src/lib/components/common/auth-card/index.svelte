<script lang="ts">
	// The signed-out card the sign-in and sign-up pages use, shared so the
	// password-reset and confirmation pages stop rendering as bare, unstyled
	// forms in the top-left corner of an empty page.
	interface Props {
		title: string;
		sub?: string;
		children?: import('svelte').Snippet;
	}

	let { title, sub, children }: Props = $props();
</script>

<div class="auth-wrap">
	<div class="auth-card">
		<div class="auth-brand">
			<span class="mark">
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="#fff"
					stroke-width="2.4"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M3 12h4l2.5-7 5 14 2.5-7H21" /></svg
				>
			</span>
			<b style="font-size:14.5px">nabz</b>
		</div>
		<h1>{title}</h1>
		{#if sub}<p class="sub">{sub}</p>{/if}
		<div class="auth-body">{@render children?.()}</div>
	</div>
</div>

<style>
	.auth-body :global(.alert) {
		margin-bottom: 14px;
	}
</style>
