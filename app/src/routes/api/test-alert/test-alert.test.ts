import { describe, expect, it, vi } from 'vitest';
import { POST } from './+server';

// A fake user client: pendingCount is what the pending-check list returns.
function locals(pendingCount: number) {
	const create = vi.fn().mockResolvedValue({ id: 't1' });
	const getOne = vi.fn().mockResolvedValue({ status: 'done', result: 'Notified 1 channel(s)' });
	const getList = vi.fn().mockResolvedValue({ totalItems: pendingCount, items: [] });
	const pb = {
		filter: (expr: string, params: Record<string, string>) => `${expr} ${JSON.stringify(params)}`,
		collection: () => ({ create, getOne, getList })
	};
	return { l: { user: { id: 'u1' }, pb }, create };
}

function call(l: unknown) {
	const request = new Request('http://x/api/test-alert', { method: 'POST', body: '{}' });
	return POST({ locals: l, request } as never);
}

describe('POST /api/test-alert', () => {
	// One pending test per user (#670): the queue used to be unlimited.
	it('refuses while a test alert is still pending for the user', async () => {
		const { l, create } = locals(1);
		const res = await call(l);
		expect(res.status).toBe(429);
		expect(create).not.toHaveBeenCalled();
	});

	it('queues one when nothing is pending', async () => {
		vi.useFakeTimers();
		const { l, create } = locals(0);
		const pending = call(l);
		await vi.advanceTimersByTimeAsync(1500);
		const res = await pending;
		vi.useRealTimers();
		expect(create).toHaveBeenCalledTimes(1);
		expect((await res.json()).done).toBe(true);
	});
});
