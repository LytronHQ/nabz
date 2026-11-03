<script lang="ts">
	// The top bar of the standalone public pages (/pricing, /tools): brand, a few
	// links and the theme switch. No app shell, signed in or not.
	import { resolve } from '$app/paths';
	import { ThemeToggle } from '#lib/components/common/index.js';
</script>

<header class="ph">
	<a class="ph-brand" href={resolve('/')} aria-label="nabz home">
		<span class="ph-mark">
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="#fff"
				stroke-width="2.4"
				stroke-linecap="round"
				stroke-linejoin="round"><path d="M3 12h4l2.5-7 5 14 2.5-7H21"></path></svg
			>
		</span>
		<b>nabz</b>
	</a>
	<nav class="ph-links" aria-label="Site">
		<a href={resolve('/tools')}>Free tools</a>
		<a href={resolve('/pricing')}>Pricing</a>
		<a href={resolve('/signin')}>Sign in</a>
		<ThemeToggle />
	</nav>
</header>

<style>
	.ph {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding-bottom: 18px;
		border-bottom: 1px solid var(--border);
		margin-bottom: 36px;
	}
	.ph-brand {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		color: var(--ink);
		text-decoration: none;
	}
	.ph-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		background: var(--accent);
	}
	.ph-mark svg {
		width: 18px;
		height: 18px;
	}
	.ph-links {
		display: inline-flex;
		align-items: center;
		gap: 16px;
		font-size: 14px;
	}
	.ph-links a {
		color: var(--ink);
		/* A label that wraps breaks the bar on a phone (#695, #700). */
		white-space: nowrap;
	}
	@media (max-width: 420px) {
		.ph-links {
			gap: 12px;
		}
	}
</style>
