import { afterEach, expect, test, vi } from 'vitest';
import { get, readable } from 'svelte/store';
import AlertChannelsStore from './alert-channels-store';
import type { AlertChannelsList } from '#lib/models/alert-channel.js';

const record = { id: 'ch1', type: 'email', name: 'ops', enabled: true, config: { email: 'a@b.c' } };
const page = (items: unknown[]) => ({
	page: 1,
	perPage: 10,
	totalItems: items.length,
	totalPages: 1,
	items
});
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

// #641: the page's first list load was still in flight when the user saved. The
// add threw on the unloaded list (the dialog stayed open), and the late load then
// painted the list as it was before the save.
test('an add that lands before the first list load is neither lost nor fatal', async () => {
	let releaseFirstLoad!: (r: Response) => void;
	let loads = 0;
	vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
		if (init?.method === 'POST') return Promise.resolve(json(record, 201));
		loads++;
		if (loads === 1) return new Promise<Response>((r) => (releaseFirstLoad = r));
		return Promise.resolve(json(page([record])));
	});

	const store = new AlertChannelsStore();
	const firstLoad = store.getAll();
	await expect(store.add({ type: 'email', name: 'ops', enabled: true } as never)).resolves.toBe(
		true
	);

	releaseFirstLoad(json(page([])));
	await firstLoad;

	const channels = get(readable({} as AlertChannelsList, (set) => store.subscribeChannels(set)));
	expect(channels.items.map((c) => c.id)).toEqual(['ch1']);
	expect(loads).toBe(2);
});
