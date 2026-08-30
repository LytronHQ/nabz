<script lang="ts">
	import { resolve } from '$app/paths';

	// Monitor map (#222, refined in #280): a force-directed, bipartite graph — monitor
	// nodes link to shared tag/domain HUB nodes, so a monitor with several tags links
	// to several hubs and overlapping tags form one interconnected web (not isolated
	// clusters). Svelte renders the SVG; d3-force runs the layout; d3-zoom/d3-drag
	// handle pan/zoom and node dragging. Colours are Blueprint status tokens on monitor
	// nodes (green/red reserved for up/down; amber pending; grey paused), petrol on hubs.
	//
	// #280 adds: an extended legend (incl. pending), a search box that highlights
	// matches, an on-canvas node counter, a Compact/Wide layout toggle, and a name +
	// 24h-uptime line under each monitor node.
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

	type Mon = {
		id: string;
		name: string;
		status: string;
		tags: string[];
		domain: string | null;
		uptime24h: number | null;
	};
	interface Props {
		monitors?: Mon[];
		mode?: 'tag' | 'domain';
	}

	let { monitors = [], mode = 'tag' }: Props = $props();

	type Node = {
		id: string;
		kind: 'monitor' | 'hub';
		label: string;
		status?: string;
		uptime?: number | null;
		r: number;
		x?: number;
		y?: number;
		fx?: number | null;
		fy?: number | null;
	};
	// d3-force mutates source/target from ids to node objects in place, so they're
	// `any` here (avoids casts in the template, which Svelte's parser rejects).
	type Link = { source: any; target: any };

	let svgEl: SVGSVGElement | undefined = $state();
	let width = $state(900);
	const height = 560;
	let tf: ZoomTransform = $state(zoomIdentity);
	let nodes: Node[] = $state([]);
	let links: Link[] = $state([]);
	// Stable id-based edge list (d3 mutates `links` in place), for hub-match lookups.
	let edges: { mon: string; hub: string }[] = $state([]);
	let sim: Simulation<Node, Link> | null = $state(null);
	let hovered: string | null = $state(null);
	let dragMoved = false;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;

	// #280 controls.
	let search = $state('');
	let spread: 'compact' | 'wide' = $state('compact');

	// Interactive hover popup: keep it up while the pointer is over the node OR the
	// popup (a short close delay bridges the gap), so its "View details" link is
	// reachable.
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

	function buildGraph(mons: Mon[], m: 'tag' | 'domain') {
		const ns: Node[] = [];
		const ls: Link[] = [];
		const es: { mon: string; hub: string }[] = [];
		const hubs = new Map<string, Node>();
		const hub = (key: string): Node => {
			const id = 'hub:' + key;
			let h = hubs.get(id);
			if (!h) {
				h = { id, kind: 'hub', label: key, r: 14 };
				hubs.set(id, h);
				ns.push(h);
			}
			return h;
		};
		for (const mon of mons) {
			ns.push({
				id: mon.id,
				kind: 'monitor',
				label: mon.name,
				status: mon.status,
				uptime: mon.uptime24h,
				r: 9
			});
			const keys =
				m === 'tag' ? (mon.tags.length ? mon.tags : ['untagged']) : [mon.domain ?? 'no domain'];
			for (const k of keys) {
				const h = hub(k);
				ls.push({ source: mon.id, target: h.id });
				es.push({ mon: mon.id, hub: h.id });
			}
		}
		return { nodes: ns, links: ls, edges: es };
	}

	function start() {
		if (!svgEl) return;
		const g = buildGraph(monitors, mode);
		// Carry over positions of surviving nodes so switching mode isn't a full reshuffle.
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
		edges = g.edges;
		// Wide = stronger repulsion + longer links, for a more spacious read of a big
		// fleet; compact = the original tighter layout. (A force graph has no inherent
		// "direction"; this is the meaningful layout control — see #280.)
		const wide = spread === 'wide';
		sim?.stop();
		sim = forceSimulation<Node>(nodes)
			.force(
				'link',
				forceLink<Node, Link>(links)
					.id((d) => d.id)
					.distance((l) => ((l.target as Node).kind === 'hub' ? (wide ? 104 : 64) : wide ? 76 : 48))
					.strength(0.25)
			)
			.force(
				'charge',
				forceManyBody().strength((d) =>
					(d as Node).kind === 'hub' ? (wide ? -560 : -320) : wide ? -280 : -140
				)
			)
			.force('center', forceCenter(width / 2, height / 2))
			.force(
				'collide',
				forceCollide<Node>((d) => d.r + (wide ? 10 : 6))
			)
			.on('tick', () => {
				nodes = nodes;
				links = links;
			});
	}

	function setSpread(s: 'compact' | 'wide') {
		if (s === spread) return;
		spread = s;
		start();
	}

	let lastKey = $state('');
	$effect(() => {
		const key = mode + '|' + monitors.map((m) => m.id).join(',');
		if (sim && key !== lastKey) {
			lastKey = key;
			start();
		}
	});

	// --- Search / highlight (#280) ---
	let q = $derived(search.trim().toLowerCase());
	// null = no filter (everything at full opacity); otherwise the set of matching ids.
	let matchIds = $derived(
		q
			? new Set(
					monitors
						.filter(
							(m) =>
								m.name.toLowerCase().includes(q) ||
								(m.domain ?? '').toLowerCase().includes(q) ||
								m.tags.some((t) => t.toLowerCase().includes(q))
						)
						.map((m) => m.id)
				)
			: null
	);
	let matchCount = $derived(matchIds ? matchIds.size : monitors.length);
	// A hub stays lit if any monitor linked to it matches (recomputes only when the
	// match set or the graph changes, not every tick).
	let activeHubs = $derived(
		matchIds && edges.length
			? new Set(edges.filter((e) => matchIds!.has(e.mon)).map((e) => e.hub))
			: null
	);

	function dimNode(n: Node): boolean {
		if (!matchIds) return false;
		return n.kind === 'monitor' ? !matchIds.has(n.id) : !(activeHubs && activeHubs.has(n.id));
	}
	function dimEdge(l: Link): boolean {
		return matchIds ? !matchIds.has((l.source as Node).id) : false;
	}

	onMount(() => {
		const z = d3zoom<SVGSVGElement, unknown>()
			.scaleExtent([0.25, 4])
			.on('zoom', (e) => (tf = e.transform));
		select(svgEl!).call(z);
		lastKey = mode + '|' + monitors.map((m) => m.id).join(',');
		start();
	});
	onDestroy(() => {
		sim?.stop();
		clearTimeout(hideTimer);
	});

	// Drag a node; account for the current zoom transform. `update` keeps the closure
	// pointing at the current node object across mode rebuilds.
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
	const truncate = (s: string, n = 16) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

	// The hovered monitor + its screen position (node graph coords through the zoom
	// transform), so the HTML popup can be anchored to it.
	let hoveredNode = $derived(hovered ? nodes.find((n) => n.id === hovered) : null);
	let hoveredMon = $derived(hovered ? monitors.find((m) => m.id === hovered) : null);
	let popupXY = $derived(
		hoveredNode && hoveredNode.x != null && hoveredNode.y != null
			? tf.apply([hoveredNode.x, hoveredNode.y])
			: null
	);

	function resetView() {
		tf = zoomIdentity;
		if (svgEl) select(svgEl).call((d3zoom() as any).transform, zoomIdentity);
	}
</script>

<div class="map-wrap">
	<div class="map" bind:clientWidth={width}>
		{#if monitors.length === 0}
			<div class="empty">No monitors to map yet.</div>
		{:else}
			<div class="legend">
				<span><i style="background:var(--status-up)"></i>up</span>
				<span><i style="background:var(--status-down)"></i>down</span>
				<span><i style="background:var(--status-pending)"></i>pending</span>
				<span><i style="background:var(--status-paused)"></i>paused</span>
				<span class="hub-key">
					<svg class="hicon" viewBox="0 0 24 24" aria-hidden="true">
						{#if mode === 'tag'}
							<path
								d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"
							/>
							<line x1="7" y1="7" x2="7.01" y2="7" />
						{:else}
							<circle cx="12" cy="12" r="10" />
							<line x1="2" y1="12" x2="22" y2="12" />
							<path
								d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
							/>
						{/if}
					</svg>{mode === 'tag' ? 'tag' : 'domain'}</span
				>
			</div>

			<div class="controls">
				<input
					class="search"
					type="search"
					placeholder="Search monitors…"
					aria-label="Search monitors"
					bind:value={search}
				/>
				<span class="counter" title="rendered nodes (monitors + hubs)">
					{nodes.length} node{nodes.length === 1 ? '' : 's'}{#if matchIds}
						· {matchCount} match{/if}
				</span>
				<div class="seg small" role="group" aria-label="Layout spread">
					<button class:on={spread === 'compact'} onclick={() => setSpread('compact')}
						>Compact</button
					>
					<button class:on={spread === 'wide'} onclick={() => setSpread('wide')}>Wide</button>
				</div>
				<button type="button" class="reset" onclick={resetView}>Reset</button>
			</div>

			<svg bind:this={svgEl} {width} {height} role="img" aria-label="Monitor map">
				<g transform="translate({tf.x},{tf.y}) scale({tf.k})">
					{#each links as l, i (i)}
						<line
							class="edge"
							x1={l.source.x}
							y1={l.source.y}
							x2={l.target.x}
							y2={l.target.y}
							opacity={dimEdge(l) ? 0.1 : 1}
						/>
					{/each}
					{#each nodes as n (n.id)}
						{#if n.kind === 'hub'}
							<g
								class="node hub"
								transform="translate({n.x ?? 0},{n.y ?? 0})"
								use:draggable={n}
								opacity={dimNode(n) ? 0.2 : 1}
							>
								<rect x={-n.r} y={-n.r} width={n.r * 2} height={n.r * 2} rx="5" />
								<g class="hub-icon" transform="scale(0.72) translate(-12 -12)">
									{#if mode === 'tag'}
										<path
											d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"
										/>
										<line x1="7" y1="7" x2="7.01" y2="7" />
									{:else}
										<circle cx="12" cy="12" r="10" />
										<line x1="2" y1="12" x2="22" y2="12" />
										<path
											d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
										/>
									{/if}
								</g>
								<text class="hub-label" y={-n.r - 5}>{n.label}</text>
							</g>
						{:else}
							<g
								class="node mon"
								transform="translate({n.x ?? 0},{n.y ?? 0})"
								use:draggable={n}
								role="button"
								tabindex="0"
								opacity={dimNode(n) ? 0.15 : 1}
								onmouseenter={() => showPopup(n.id)}
								onmouseleave={scheduleHide}
								onclick={() => openMonitor(n.id)}
								onkeydown={(e) =>
									e.key === 'Enter' && goto(resolve('/monitors/[id]', { id: n.id }))}
							>
								<circle
									r={n.r}
									class:active={hovered === n.id}
									style="fill:{statusColor(n.status)}"
								/>
								<text class="mon-label" y={n.r + 12}>{truncate(n.label)}</text>
								{#if n.uptime != null}
									<text class="mon-metric" y={n.r + 22}>{n.uptime.toFixed(1)}%</text>
								{/if}
							</g>
						{/if}
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
				{#if hoveredMon.uptime24h != null}<span class="psep">·</span>
					{hoveredMon.uptime24h.toFixed(1)}% 24h{/if}
				{#if mode === 'tag' && hoveredMon.tags.length}<span class="psep">·</span>
					{hoveredMon.tags.join(', ')}{/if}
				{#if mode === 'domain' && hoveredMon.domain}<span class="psep">·</span>
					{hoveredMon.domain}{/if}
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
		stroke-width: 1;
	}
	.node {
		cursor: pointer;
	}
	.node.hub {
		cursor: grab;
	}
	.hub rect {
		fill: var(--surface-2);
		stroke: var(--brand);
		stroke-width: 2;
	}
	.hub-icon {
		fill: none;
		stroke: var(--brand);
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
		pointer-events: none;
	}
	.mon circle {
		stroke: var(--surface);
		stroke-width: 1.5;
		transition: stroke 0.1s;
	}
	.mon circle.active {
		stroke: var(--text-primary);
		stroke-width: 2.5;
	}
	/* Monitor name + uptime under the node — data, not status, so muted ink with a
	   surface halo (paint-order) to stay legible over edges. */
	.mon-label,
	.mon-metric {
		text-anchor: middle;
		pointer-events: none;
		paint-order: stroke;
		stroke: var(--surface);
		stroke-width: 3px;
	}
	.mon-label {
		font-size: 10px;
		font-weight: 500;
		fill: var(--text-secondary);
	}
	.mon-metric {
		font-size: 9px;
		fill: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.hub-label {
		text-anchor: middle;
		font-size: 14px;
		font-weight: 650;
		fill: var(--text-primary);
		pointer-events: none;
		paint-order: stroke;
		stroke: var(--surface);
		stroke-width: 3.5px;
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
	.legend .hicon {
		width: 15px;
		height: 15px;
		fill: none;
		stroke: var(--brand);
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	/* Top-right control cluster: search, counter, layout toggle, reset. */
	.controls {
		position: absolute;
		top: 10px;
		right: 12px;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}
	.search {
		width: 150px;
		padding: 4px 9px;
		font-size: 12.5px;
		color: var(--text-primary);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
	}
	.search::placeholder {
		color: var(--text-faint);
	}
	.search:focus {
		outline: none;
		border-color: var(--brand);
	}
	.counter {
		font-size: 12px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		background: color-mix(in srgb, var(--surface) 85%, transparent);
		border: 1px solid var(--border);
		border-radius: var(--radius-btn);
		padding: 3px 8px;
		white-space: nowrap;
	}
	.seg.small button {
		font-size: 11.5px;
		padding: 3px 9px;
	}
	.reset {
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--text-secondary);
		font-size: 11.5px;
		border-radius: var(--radius-pill);
		padding: 3px 9px;
		cursor: pointer;
	}
	.reset:hover {
		color: var(--text-primary);
	}
</style>
