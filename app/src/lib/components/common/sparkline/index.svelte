<script lang="ts">
	interface Props {
		/** numeric series, oldest → newest */
		data?: number[];
		/** tone maps to a design token: up | down | pend | paused | accent */
		tone?: 'up' | 'down' | 'pend' | 'paused' | 'accent';
		width?: number;
		height?: number;
	}

	let { data = [], tone = 'accent', width = 120, height = 26 }: Props = $props();

	const toneVar: Record<string, string> = {
		up: '--up',
		down: '--down',
		pend: '--pending',
		paused: '--paused',
		accent: '--accent'
	};
	let col = $derived(`var(${toneVar[tone] ?? '--accent'})`);

	let geom = $derived(
		(() => {
			const d = data && data.length ? data : [0, 0];
			const W = width,
				H = height,
				pad = 3;
			const min = Math.min(...d);
			const max = Math.max(...d);
			const span = max - min || 1;
			const n = d.length - 1 || 1;
			const X = (i: number) => pad + (i / n) * (W - 2 * pad);
			const Y = (v: number) => H - pad - ((v - min) / span) * (H - 2 * pad);
			const path = d
				.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`)
				.join(' ');
			return { path, lx: X(d.length - 1), ly: Y(d[d.length - 1]) };
		})()
	);
</script>

<svg
	viewBox="0 0 {width} {height}"
	preserveAspectRatio="none"
	{width}
	{height}
	role="img"
	aria-hidden="true"
	style="display:block"
>
	<path
		d={geom.path}
		fill="none"
		stroke={col}
		stroke-width="1.6"
		stroke-linecap="round"
		stroke-linejoin="round"
		opacity="0.9"
	/>
	<circle cx={geom.lx} cy={geom.ly} r="1.9" fill={col} />
</svg>
