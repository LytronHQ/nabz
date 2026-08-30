<script lang="ts">
	import { toasts, dismissToast, type Toast } from '$lib/stores/toast-store';
	import { fly } from 'svelte/transition';

	const glyph: Record<Toast['type'], string> = {
		success: 'M20 6 9 17l-5-5',
		error: 'M18 6 6 18M6 6l12 12',
		info: 'M12 16v-4M12 8h.01'
	};
</script>

<div class="toaster" aria-live="polite" aria-atomic="false">
	{#each $toasts as t (t.id)}
		<div class="toast {t.type}" role="status" transition:fly={{ y: 8, duration: 180 }}>
			<svg
				class="ic"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.4"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d={glyph[t.type]} />
			</svg>
			<span class="msg">{t.message}</span>
			<button type="button" class="x" aria-label="Dismiss" onclick={() => dismissToast(t.id)}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg
				>
			</button>
		</div>
	{/each}
</div>

<style>
	.toaster {
		position: fixed;
		/* Bottom-right so toasts never cover the top action buttons; offset by the
		   mobile safe-area (iOS home indicator / notch) so nothing is clipped. */
		bottom: calc(16px + env(safe-area-inset-bottom, 0px));
		right: calc(16px + env(safe-area-inset-right, 0px));
		z-index: 100;
		display: flex;
		/* Column anchored at the bottom: oldest rises, newest sits by the corner. */
		flex-direction: column;
		gap: 8px;
		max-width: min(360px, calc(100vw - 32px));
		/* The container spans the stack's bounding box; keep it click-through so it
		   never blocks the page — each toast re-enables its own pointer events. */
		pointer-events: none;
	}
	.toast {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 11px 12px;
		border-radius: var(--radius-btn);
		background: var(--surface);
		border: 1px solid var(--border);
		box-shadow: var(--shadow-strong);
		font-size: 13.5px;
		color: var(--ink);
		pointer-events: auto;
	}
	.toast .ic {
		width: 17px;
		height: 17px;
		flex: 0 0 17px;
		margin-top: 1px;
	}
	.toast.success {
		border-left: 3px solid var(--up);
	}
	.toast.success .ic {
		color: var(--up);
	}
	.toast.error {
		border-left: 3px solid var(--down);
	}
	.toast.error .ic {
		color: var(--down);
	}
	.toast.info {
		border-left: 3px solid var(--accent);
	}
	.toast.info .ic {
		color: var(--accent);
	}
	.msg {
		flex: 1 1 auto;
		line-height: 1.4;
		word-break: break-word;
	}
	.x {
		flex: 0 0 auto;
		background: none;
		border: 0;
		padding: 0;
		cursor: pointer;
		color: var(--ink-3);
		line-height: 0;
	}
	.x:hover {
		color: var(--ink);
	}
	.x svg {
		width: 14px;
		height: 14px;
	}
</style>
