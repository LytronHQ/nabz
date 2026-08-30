import { describe, it, expect } from 'vitest';
import { wouldCycle, blastRadius, type Edge } from './dependency-graph';

describe('wouldCycle', () => {
	it('rejects a self-link', () => {
		expect(wouldCycle([], 'a', 'a')).toBe(true);
	});

	it('allows an edge with no existing path back', () => {
		const edges: Edge[] = [{ from: 'a', to: 'b' }];
		// a->b exists; adding b->c is fine, and a->c is fine.
		expect(wouldCycle(edges, 'b', 'c')).toBe(false);
		expect(wouldCycle(edges, 'a', 'c')).toBe(false);
	});

	it('rejects a direct 2-cycle', () => {
		const edges: Edge[] = [{ from: 'a', to: 'b' }];
		// a->b exists; b->a would cycle.
		expect(wouldCycle(edges, 'b', 'a')).toBe(true);
	});

	it('rejects a transitive cycle', () => {
		const edges: Edge[] = [
			{ from: 'a', to: 'b' },
			{ from: 'b', to: 'c' }
		];
		// a->b->c exists; c->a would close a 3-cycle.
		expect(wouldCycle(edges, 'c', 'a')).toBe(true);
	});

	it('does not false-positive on a diamond (shared descendant, no cycle)', () => {
		const edges: Edge[] = [
			{ from: 'a', to: 'b' },
			{ from: 'a', to: 'c' },
			{ from: 'b', to: 'd' },
			{ from: 'c', to: 'd' }
		];
		// Adding a->d (another path to the shared descendant) is not a cycle.
		expect(wouldCycle(edges, 'a', 'd')).toBe(false);
	});
});

describe('blastRadius', () => {
	const edges: Edge[] = [
		{ from: 'web', to: 'api' },
		{ from: 'api', to: 'db' },
		{ from: 'worker', to: 'db' }
	];

	it('collects everything that transitively depends on the down node', () => {
		// db down -> api (depends on db) and web (depends on api) and worker.
		expect([...blastRadius(edges, 'db')].sort()).toEqual(['api', 'web', 'worker']);
	});

	it('is just the direct dependents one hop up', () => {
		expect([...blastRadius(edges, 'api')]).toEqual(['web']);
	});

	it('is empty for a leaf nothing depends on', () => {
		expect(blastRadius(edges, 'web').size).toBe(0);
	});

	it('excludes the node itself', () => {
		expect(blastRadius(edges, 'db').has('db')).toBe(false);
	});
});
