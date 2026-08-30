<script lang="ts">
	// Token modal (#168) — replaces flowbite's <Modal>. A fixed dim backdrop + a
	// surface card, Esc / backdrop-click / ✕ to close, footer actions on `.btn`.

	interface Props {
		// Both themes via tokens, so the old `.wm-modal-*` !important shim is gone.
		open?: boolean;
		title?: string;
		submitText?: string;
		cancelText?: string;
		submit?: any;
		children?: import('svelte').Snippet;
	}

	let {
		open = $bindable(false),
		title = 'Untitled',
		submitText = 'Submit',
		cancelText = 'Cancel',
		submit = async () => true,
		children
	}: Props = $props();

	// Feedback lives on the button the user clicked — not a full-screen overlay —
	// so a submit reads as "my action is working", not "the app is busy".
	let submitting = $state(false);

	export function openModal() {
		open = true;
	}
	function close() {
		if (!submitting) open = false;
	}
	async function onSubmit() {
		if (submitting) return;
		submitting = true;
		try {
			if (await submit()) open = false;
		} finally {
			submitting = false;
		}
	}
	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') close();
	}
	function onBackdrop(e: MouseEvent) {
		if (e.target === e.currentTarget) close();
	}
	function focusOnMount(node: HTMLElement) {
		node.focus();
	}
</script>

<svelte:window onkeydown={open ? onKeydown : undefined} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="wm-backdrop" onclick={onBackdrop}>
		<div
			class="wm-card"
			role="dialog"
			aria-modal="true"
			aria-label={title}
			tabindex="-1"
			use:focusOnMount
		>
			<div class="wm-head">
				<h3>{title}</h3>
				<button type="button" class="wm-x" aria-label="Close" onclick={close}>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg
					>
				</button>
			</div>
			<div class="wm-body">{@render children?.()}</div>
			<div class="wm-foot">
				<button type="button" class="btn btn-ghost" onclick={close} disabled={submitting}
					>{cancelText}</button
				>
				<button type="button" class="btn btn-primary" onclick={onSubmit} disabled={submitting}>
					{#if submitting}<span class="wm-spin"></span>{/if}
					{submitText}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.wm-backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 16px;
		background: rgba(3, 12, 14, 0.55);
		overflow-y: auto;
	}
	.wm-card {
		width: 100%;
		max-width: 600px;
		margin: 4vh 0;
		max-height: calc(100vh - 8vh);
		display: flex;
		flex-direction: column;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		outline: none;
	}
	.wm-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 13px 16px;
		border-bottom: 1px solid var(--border);
	}
	.wm-head h3 {
		margin: 0;
		font-size: 15px;
		font-weight: 640;
		color: var(--ink);
	}
	.wm-x {
		flex: 0 0 auto;
		background: none;
		border: 0;
		padding: 2px;
		cursor: pointer;
		color: var(--ink-3);
		line-height: 0;
	}
	.wm-x:hover {
		color: var(--ink);
	}
	.wm-x svg {
		width: 16px;
		height: 16px;
	}
	.wm-body {
		padding: 20px;
		overflow-y: auto;
	}
	.wm-foot {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 12px 16px;
		border-top: 1px solid var(--border);
	}
	.wm-spin {
		width: 13px;
		height: 13px;
		border: 2px solid color-mix(in srgb, var(--brand-contrast) 45%, transparent);
		border-top-color: var(--brand-contrast);
		border-radius: 50%;
		animation: wm-spin 0.7s linear infinite;
	}
	@keyframes wm-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
