<script lang="ts">
	import { onMount } from 'svelte';
	import {
		theme,
		accent,
		setTheme,
		setAccent,
		initAppearance,
		ACCENTS,
		ACCENT_HEX
	} from '$lib/appearance';

	onMount(initAppearance);
</script>

<div class="appearance">
	<span class="cap">Appearance</span>

	<div class="theme-seg" role="group" aria-label="Theme">
		<button
			type="button"
			class:on={$theme === 'system'}
			onclick={() => setTheme('system')}
			title="System"
			aria-label="System theme"
		>
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="1.8"
				stroke-linecap="round"
				stroke-linejoin="round"
				><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg
			>
		</button>
		<button
			type="button"
			class:on={$theme === 'light'}
			onclick={() => setTheme('light')}
			title="Light"
			aria-label="Light theme"
		>
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="1.8"
				stroke-linecap="round"
				stroke-linejoin="round"
				><circle cx="12" cy="12" r="4" /><path
					d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"
				/></svg
			>
		</button>
		<button
			type="button"
			class:on={$theme === 'dark'}
			onclick={() => setTheme('dark')}
			title="Dark"
			aria-label="Dark theme"
		>
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="1.8"
				stroke-linecap="round"
				stroke-linejoin="round"><path d="M21 12.8A8.5 8.5 0 1111.2 3a6.6 6.6 0 009.8 9.8z" /></svg
			>
		</button>
	</div>

	<div class="accents" role="group" aria-label="Accent colour">
		{#each ACCENTS as a (a)}
			<button
				type="button"
				class="dot"
				class:on={$accent === a}
				style="--c:{ACCENT_HEX[a]}"
				title={a}
				aria-label="{a} accent"
				aria-pressed={$accent === a}
				onclick={() => setAccent(a)}
			></button>
		{/each}
	</div>
</div>

<style>
	.appearance {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 8px;
	}
	.cap {
		font-family: inherit;
		font-size: 10px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.theme-seg {
		display: flex;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		padding: 3px;
		gap: 2px;
	}
	.theme-seg button {
		flex: 1;
		display: grid;
		place-items: center;
		height: 26px;
		border: 0;
		background: transparent;
		color: var(--ink-3);
		border-radius: var(--radius-btn);
		cursor: pointer;
	}
	.theme-seg button svg {
		width: 15px;
		height: 15px;
	}
	.theme-seg button:hover {
		color: var(--ink);
	}
	.theme-seg button.on {
		background: var(--surface);
		color: var(--accent-strong);
		box-shadow: var(--shadow);
	}

	.accents {
		display: flex;
		gap: 7px;
		padding: 2px;
	}
	.dot {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--c);
		border: 2px solid transparent;
		cursor: pointer;
		padding: 0;
		box-shadow: 0 0 0 1px var(--border) inset;
	}
	.dot:hover {
		transform: scale(1.12);
	}
	.dot.on {
		border-color: var(--surface);
		box-shadow: 0 0 0 2px var(--c);
	}
</style>
