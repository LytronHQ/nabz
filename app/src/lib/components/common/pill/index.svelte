<script lang="ts" module>
	export type PillTone =
		'up' | 'down' | 'pending' | 'paused' | 'rate-limited' | 'maintenance' | 'acknowledged';
</script>

<script lang="ts">
	// Generic status pill (#165). Renders the app-wide `.pill` markup with the tone
	// colour and optional pulsing `live` dot. Extra attributes (e.g. `style`) pass
	// through to the span. StatusBadge renders through this; the ~20 previously
	// hand-rolled pills now use it too.
	const CLS: Record<PillTone, string> = {
		up: 'up',
		down: 'down',
		pending: 'pend',
		paused: 'paused',
		'rate-limited': 'rate',
		maintenance: 'maint',
		acknowledged: 'ack'
	};

	interface Props {
		tone: PillTone;
		label?: string;
		live?: boolean;
		[key: string]: any;
	}

	let { tone, label = '', live = false, ...rest }: Props = $props();
</script>

<span class="pill {CLS[tone]}" class:live {...rest}><i class="glyph"></i>{label}</span>
