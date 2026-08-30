// Pure graph helpers for monitor dependencies (#223). An edge `from -> to` means
// "from depends on to": if `to` goes down, `from` is in the blast radius.

export type Edge = { from: string; to: string };

function forwardAdjacency(edges: Edge[]): Map<string, string[]> {
	const adj = new Map<string, string[]>();
	for (const e of edges) {
		const list = adj.get(e.from) ?? [];
		list.push(e.to);
		adj.set(e.from, list);
	}
	return adj;
}

// Would adding `from -> to` close a loop? True iff `to` can already reach `from`
// by following existing edges (so the new edge would complete the cycle). A
// self-link (from === to) is trivially a cycle.
export function wouldCycle(edges: Edge[], from: string, to: string): boolean {
	if (from === to) return true;
	const adj = forwardAdjacency(edges);
	const seen = new Set<string>();
	const queue = [to];
	while (queue.length) {
		const node = queue.shift() as string;
		if (node === from) return true;
		if (seen.has(node)) continue;
		seen.add(node);
		for (const next of adj.get(node) ?? []) queue.push(next);
	}
	return false;
}

// The blast radius of a monitor: every OTHER monitor that depends on it, directly
// or transitively (i.e. can reach it by following edges). These are the ones
// impacted when `downId` goes down. The node itself is not included.
export function blastRadius(edges: Edge[], downId: string): Set<string> {
	// Reverse adjacency: to -> [from], so we can walk "who depends on me".
	const rev = new Map<string, string[]>();
	for (const e of edges) {
		const list = rev.get(e.to) ?? [];
		list.push(e.from);
		rev.set(e.to, list);
	}
	const impacted = new Set<string>();
	const queue = [downId];
	const seen = new Set<string>([downId]);
	while (queue.length) {
		const node = queue.shift() as string;
		for (const dependent of rev.get(node) ?? []) {
			if (!seen.has(dependent)) {
				seen.add(dependent);
				impacted.add(dependent);
				queue.push(dependent);
			}
		}
	}
	return impacted;
}
