<script lang="ts">
	import { resolve } from '$app/paths';

	// Dependency graph (#223): a DIRECTED force graph of monitor → monitor
	// dependencies (an edge from A to B means "A depends on B"). Reuses the
	// monitor-map's d3-force / d3-zoom / d3-drag scaffolding (#222); the new parts
	// are arrowheads (direction) and blast-radius highlighting — when a monitor is
	// down, everything that transitively depends on it is ringed in amber. Status
	// green/red stay reserved for up/down, so the blast tint is a distinct hue.
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		forceSimulation,
		forceLink,
		forceManyBody,
		forceCenter,
		forceCollide,
		type Simulation
	} from 'd3-force';
	import { select, pointer } from 'd3-selection';
	import { zoom as d3zoom, zoomIdentity, type ZoomTransform } from 'd3-zoom';
	import { drag as d3drag } from 'd3-drag';
	import { blastRadius, type Edge } from '$lib/utils/dependency-graph';

	type Mon = { id: string; name: string; status: string };
	interface Props {
		monitors?: Mon[];
		edges?: Edge[];
	}

	let { monitors = [], edges = [] }: Props = $props();

	type Node = {
		id: string;
		label: string;
		status: string;
		r: number;
		x?: number;
		y?: number;
		fx?: number | null;
		fy?: number | null;
	};
	// d3-force mutates source/target from ids to node objects in place.
	type Link = { source: any; target: any };

	let svgEl: SVGSVGElement | undefined = $state();
	let width = $state(900);
	const height = 560;
	let tf: ZoomTransform = $state(zoomIdentity);
	let nodes: Node[] = $state([]);
	let links: Link[] = $state([]);
	let sim: Simulation<Node, Link> | null = $state(null);
	let hovered: string | null = $state(null);
	let dragMoved = false;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;

	// Only edges whose endpoints both still exist as monitors.
	let validEdges = $derived(
		edges.filter(
			(e) => monitors.some((m) => m.id === e.from) && monitors.some((m) => m.id === e.to)
		)
	);

	// Blast radius: the union of everything that depends (transitively) on any DOWN
	// monitor — these are "impacted". Down monitors themselves keep their red status.
	let impacted = $derived(
		(() => {
			const set = new Set<string>();
			for (const m of monitors) {
				if (m.status === 'down') for (const id of blastRadius(validEdges, m.id)) set.add(id);
			}
			return set;
		})()
	);
	let affected = $derived(
		new Set<string>([...impacted, ...monitors.filter((m) => m.status === 'down').map((m) => m.id)])
	);
	const edgeHot = (l: Link) => impacted.has(idOf(l.source)) && affected.has(idOf(l.target));
	const idOf = (endpoint: any) => (typeof endpoint === 'string' ? endpoint : endpoint?.id);

	function showPopup(id: string) {
		clearTimeout(hideTimer);
		hovered = id;
	}
	function scheduleHide() {
		clearTimeout(hideTimer);
		hideTimer = setTimeout(() => (hovered = null), 140);
	}
	function cancelHide() {
		clearTimeout(hideTimer);
	}

	function buildGraph(mons: Mon[], es: Edge[]) {
		const ns: Node[] = mons.map((m) => ({ id: m.id, label: m.name, status: m.status, r: 11 }));
		const ids = new Set(mons.map((m) => m.id));
		const ls: Link[] = es
			.filter((e) => ids.has(e.from) && ids.has(e.to))
			.map((e) => ({ source: e.from, target: e.to }));
		return { nodes: ns, links: ls };
	}

	function start() {
		if (!svgEl) return;
		const g = buildGraph(monitors, edges);
		// Carry over positions so an add/remove doesn't reshuffle the whole layout.
		const prev = new Map(nodes.map((n) => [n.id, n]));
		for (const n of g.nodes) {
			const p = prev.get(n.id);
			if (p) {
				n.x = p.x;
				n.y = p.y;
			}
		}
		nodes = g.nodes;
		links = g.links;
		sim?.stop();
		sim = forceSimulation<Node>(nodes)
			.force(
				'link',
				forceLink<Node, Link>(links)
					.id((d) => d.id)
					.distance(96)
					.strength(0.2)
			)
			.force('charge', forceManyBody().strength(-260))
			.force('center', forceCenter(width / 2, height / 2))
			.force(
				'collide',
				forceCollide<Node>((d) => d.r + 10)
			)
			.on('tick', () => {
				nodes = nodes;
				links = links;
			});
	}

	let lastKey = $state('');
	$effect(() => {
		const key =
			monitors.map((m) => m.id + ':' + m.status).join(',') +
			'|' +
			edges.map((e) => e.from + '>' + e.to).join(',');
		if (sim && key !== lastKey) {
			lastKey = key;
			start();
		}
	});

	onMount(() => {
		const z = d3zoom<SVGSVGElement, unknown>()
			.scaleExtent([0.25, 4])
			.on('zoom', (e) => (tf = e.transform));
		select(svgEl!).call(z);
		lastKey =
			monitors.map((m) => m.id + ':' + m.status).join(',') +
			'|' +
			edges.map((e) => e.from + '>' + e.to).join(',');
		start();
	});
	onDestroy(() => {
		sim?.stop();
		clearTimeout(hideTimer);
	});

	function draggable(el: SVGGElement, node: Node) {
		let n = node;
		const beh = d3drag<SVGGElement, unknown>()
			.on('start', (e) => {
				e.sourceEvent.stopPropagation();
				dragMoved = false;
				if (!e.active) sim?.alphaTarget(0.3).restart();
				n.fx = n.x;
				n.fy = n.y;
			})
			.on('drag', (e) => {
				dragMoved = true;
				const [x, y] = tf.invert(pointer(e.sourceEvent, svgEl));
				n.fx = x;
				n.fy = y;
			})
			.on('end', (e) => {
				if (!e.active) sim?.alphaTarget(0);
				n.fx = null;
				n.fy = null;
			});
		select(el).call(beh);
		return {
			update(nn: Node) {
				n = nn;
			},
			destroy() {
				select(el).on('.drag', null);
			}
		};
	}

	function openMonitor(id: string) {
		if (!dragMoved) goto(resolve('/monitors/[id]', { id: id }));
	}

	const statusColor = (s?: string) =>
		s === 'up'
			? 'var(--status-up)'
			: s === 'down'
				? 'var(--status-down)'
				: s === 'paused'
					? 'var(--status-paused)'
					: 'var(--status-pending)';
	const statusLabel = (s?: string) => (s ? s[0].toUpperCase() + s.slice(1) : '—');

	// Trim each edge to the node perimeters and leave room for the arrowhead so it
	// sits on the target's edge, not under it.
	function geom(l: Link) {
		const s = l.source,
			t = l.target;
		const sx = s?.x ?? 0,
			sy = s?.y ?? 0,
			tx = t?.x ?? 0,
			ty = t?.y ?? 0;
		const dx = tx - sx,
			dy = ty - sy;
		const len = Math.hypot(dx, dy) || 1;
		const ux = dx / len,
			uy = dy / len;
		const sr = (s?.r ?? 11) + 3;
		const tr = (t?.r ?? 11) + 9;
		return { x1: sx + ux * sr, y1: sy + uy * sr, x2: tx - ux * tr, y2: ty - uy * tr };
	}

	let hoveredNode = $derived(hovered ? nodes.find((n) => n.id === hovered) : null);
	let hoveredMon = $derived(hovered ? monitors.find((m) => m.id === hovered) : null);
	let popupXY = $derived(
		hoveredNode && hoveredNode.x != null && hoveredNode.y != null
			? tf.apply([hoveredNode.x, hoveredNode.y])
			: null
	);
	// How many monitors depend on the hovered one (its blast radius size) — shown in
	// the popup so you can gauge impact without reading the whole graph.
	let hoveredDependents = $derived(hovered ? blastRadius(validEdges, hovered).size : 0);

	function resetView() {
		tf = zoomIdentity;
		if (svgEl) select(svgEl).call((d3zoom() as any).transform, zoomIdentity);
	}
</script>

<div class="map-wrap">
	<div class="map" bind:clientWidth={width}>
		{#if monitors.length === 0}
			<div class="empty">No monitors to graph yet.</div>
		{:else}
			<div class="legend">
				<span><i style="background:var(--status-up)"></i>up</span>
				<span><i style="background:var(--status-down)"></i>down</span>
				<span class="blast-key"><i></i>blast radius</span>
				<button type="button" class="reset" onclick={resetView}>Reset view</button>
			</div>
			<svg bind:this={svgEl} {width} {height} role="img" aria-label="Dependency graph">
				<defs>
					<marker
						id="dep-arrow"
						viewBox="0 0 10 10"
						refX="8"
						refY="5"
						markerWidth="6.5"
						markerHeight="6.5"
						orient="auto-start-reverse"
					>
						<path d="M0 0 L10 5 L0 10 z" fill="var(--text-muted)" />
					</marker>
					<marker
						id="dep-arrow-hot"
						viewBox="0 0 10 10"
						refX="8"
						refY="5"
						markerWidth="6.5"
						markerHeight="6.5"
						orient="auto-start-reverse"
					>
						<path d="M0 0 L10 5 L0 10 z" fill="var(--blast)" />
					</marker>
				</defs>
				<g transform="translate({tf.x},{tf.y}) scale({tf.k})">
					{#each links as l, i (i)}
						{@const g = geom(l)}
						{@const hot = edgeHot(l)}
						<line
							class="edge"
							class:hot
							x1={g.x1}
							y1={g.y1}
							x2={g.x2}
							y2={g.y2}
							marker-end="url({hot ? '#dep-arrow-hot' : '#dep-arrow'})"
						/>
					{/each}
					{#each nodes as n (n.id)}
						<g
							class="node"
							class:impacted={impacted.has(n.id)}
							transform="translate({n.x ?? 0},{n.y ?? 0})"
							use:draggable={n}
							role="button"
							tabindex="0"
							onmouseenter={() => showPopup(n.id)}
							onmouseleave={scheduleHide}
							onclick={() => openMonitor(n.id)}
							onkeydown={(e) => e.key === 'Enter' && goto(resolve('/monitors/[id]', { id: n.id }))}
						>
							{#if impacted.has(n.id)}
								<circle class="ring" r={n.r + 4} />
							{/if}
							<circle
								r={n.r}
								class:active={hovered === n.id}
								style="fill:{statusColor(n.status)}"
							/>
							<text class="mon-label" y={-n.r - 6}>{n.label}</text>
						</g>
					{/each}
				</g>
			</svg>
		{/if}
	</div>

	{#if hoveredMon && popupXY}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="popup"
			style="left:{popupXY[0]}px; top:{popupXY[1]}px"
			role="tooltip"
			onmouseenter={cancelHide}
			onmouseleave={scheduleHide}
		>
			<div class="popup-name">{hoveredMon.name}</div>
			<div class="popup-meta">
				<span class="pdot" style="background:{statusColor(hoveredMon.status)}"></span>
				{statusLabel(hoveredMon.status)}
				{#if hoveredDependents > 0}<span class="psep">·</span> {hoveredDependents} downstream{/if}
			</div>
			<a class="popup-link" href={resolve('/monitors/[id]', { id: hoveredMon.id })}
				>View details →</a
			>
		</div>
	{/if}
</div>

<style>
	.map-wrap {
		position: relative;
	}
	.map {
		position: relative;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
		/* Distinct amber for "blast radius", separate from reserved status green/red. */
		--blast: #e0912f;
	}
	svg {
		display: block;
		width: 100%;
		cursor: grab;
	}
	svg:active {
		cursor: grabbing;
	}
	.empty {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 200px;
		font-size: 13px;
		color: var(--text-muted);
	}
	.edge {
		stroke: var(--border);
		stroke-width: 1.5;
	}
	.edge.hot {
		stroke: var(--blast);
		stroke-width: 2.4;
	}
	.node {
		cursor: pointer;
	}
	.node circle {
		stroke: var(--surface);
		stroke-width: 1.5;
	}
	.node circle.active {
		stroke: var(--text-primary);
		stroke-width: 2.5;
	}
	.ring {
		fill: none;
		stroke: var(--blast);
		stroke-width: 2.5;
		opacity: 0.9;
	}
	.mon-label {
		text-anchor: middle;
		font-size: 12.5px;
		fill: var(--text-primary);
		pointer-events: none;
		paint-order: stroke;
		stroke: var(--surface);
		stroke-width: 3.5px;
	}
	.legend {
		position: absolute;
		top: 10px;
		left: 12px;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: 12px;
		font-size: 12.5px;
		color: var(--text-secondary);
		background: color-mix(in srgb, var(--surface) 85%, transparent);
		padding: 5px 9px;
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
	}
	.legend span {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.legend i {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		display: inline-block;
	}
	.legend .blast-key i {
		background: transparent;
		border: 2px solid var(--blast);
		width: 10px;
		height: 10px;
	}
	.reset {
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--text-secondary);
		font-size: 11.5px;
		border-radius: var(--radius-pill);
		padding: 2px 8px;
		cursor: pointer;
	}
	.reset:hover {
		color: var(--text-primary);
	}
	.popup {
		position: absolute;
		z-index: 2;
		transform: translate(-50%, calc(-100% - 16px));
		min-width: 200px;
		max-width: 300px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		box-shadow: 0 8px 22px rgba(0, 0, 0, 0.16);
		padding: 13px 15px;
		pointer-events: auto;
	}
	.popup-name {
		font-size: 15px;
		font-weight: 600;
		color: var(--text-primary);
		line-height: 1.3;
		word-break: break-word;
	}
	.popup-meta {
		margin-top: 6px;
		font-size: 13px;
		color: var(--text-secondary);
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 5px;
	}
	.pdot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		display: inline-block;
	}
	.psep {
		color: var(--text-muted);
	}
	.popup-link {
		display: inline-block;
		margin-top: 10px;
		font-size: 13px;
		font-weight: 500;
		color: var(--brand);
		text-decoration: none;
	}
	.popup-link:hover {
		text-decoration: underline;
	}
</style>
