<script lang="ts">
	import { Pill, type PillTone } from '$lib/components/common/pill';

	interface Props {
		status?: string;
		/** Override the pulsing dot. Left unset, it follows the status — see LIVE
		 *  below, which is where that rule belongs: whether a status is "beating"
		 *  is a property of the status, not a decision for each call site. Three
		 *  call sites previously each wrote `live={status === 'up'}`, which is why
		 *  Pending and Down never pulsed. */
		live?: boolean;
	}

	let { status = 'pending', live = undefined }: Props = $props();

	const map: Record<string, { label: string; tone: PillTone }> = {
		up: { label: 'Up', tone: 'up' },
		down: { label: 'Down', tone: 'down' },
		pending: { label: 'Pending', tone: 'pending' },
		paused: { label: 'Paused', tone: 'paused' },
		'rate-limited': { label: 'Rate-limited', tone: 'rate-limited' },
		maintenance: { label: 'Maintenance', tone: 'maintenance' }
	};

	// The app is called nabz — "beat" — so a live status beats. Down and Pending
	// are live states too, and arguably the ones worth noticing.
	//
	// Paused is deliberately excluded: it is the one status that genuinely is not
	// beating, and keeping it still is what makes the animation mean anything.
	// Rate-limited and maintenance are likewise holding states, not heartbeats.
	const LIVE = new Set(['up', 'down', 'pending']);

	let s = $derived(map[status] ?? map.pending);
	let isLive = $derived(live ?? LIVE.has(status));
</script>

<Pill tone={s.tone} label={s.label} live={isLive} />
