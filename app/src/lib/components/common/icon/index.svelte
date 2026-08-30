<script lang="ts" module>
	export type IconName =
		| 'plus'
		| 'edit'
		| 'trash'
		| 'pause'
		| 'play'
		| 'dashboard'
		| 'activity'
		| 'incidents'
		| 'alerts'
		| 'escalations'
		| 'dependencies'
		| 'usage'
		| 'signout';
</script>

<script lang="ts">
	// Single source of truth for the app's inline SVG glyphs (#163). Renders a 24×24
	// stroke (or fill) icon; the size comes from the surrounding CSS (e.g. `.btn svg`,
	// `.nav a svg`, `.row-actions svg`) exactly like the inline SVGs it replaces, so no
	// size prop is needed.
	type Def = { d: string; sw?: number; fill?: boolean };

	const ICONS: Record<IconName, Def> = {
		plus: { d: '<path d="M12 5v14M5 12h14"/>', sw: 2.2 },
		edit: { d: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>' },
		trash: { d: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>' },
		pause: {
			d: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'
		},
		play: { d: '<path d="M7 4.5v15l13-7.5z"/>', fill: true },
		dashboard: {
			d: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'
		},
		activity: { d: '<path d="M3 12h3l2-6 4 12 2.5-7 1.5 3H21"/>' },
		incidents: { d: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/>' },
		alerts: {
			d: '<path d="M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M10.5 21a1.8 1.8 0 003 0"/>'
		},
		escalations: { d: '<path d="M12 19V5M5 12l7-7 7 7"/><path d="M6 21h12"/>' },
		dependencies: {
			d: '<circle cx="5" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="12" r="2.5"/><path d="M7.3 6.1l9.4 4.8M7.3 17.9l9.4-4.8"/>'
		},
		usage: { d: '<path d="M4 20V12M9.3 20V7M14.7 20v-9M20 20V5"/><path d="M3 20h18"/>' },
		signout: {
			d: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>'
		}
	};

	interface Props {
		name: IconName;
	}

	let { name }: Props = $props();
	let def = $derived(ICONS[name]);
</script>

{#if def}
	<svg
		viewBox="0 0 24 24"
		fill={def.fill ? 'currentColor' : 'none'}
		stroke={def.fill ? 'none' : 'currentColor'}
		stroke-width={def.fill ? undefined : (def.sw ?? 1.8)}
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true">{@html def.d}</svg
	>
{/if}
