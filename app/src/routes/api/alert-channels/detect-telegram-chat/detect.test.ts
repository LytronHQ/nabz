import { test, expect, vi, afterEach } from 'vitest';
import { POST } from './+server';

function ev(body: any, user: any = { id: 'u1' }) {
	return { locals: { user }, request: { json: async () => body } } as any;
}
function tg(ok: boolean, payload: any, status = 200) {
	return { ok, status, json: async () => payload } as any;
}
afterEach(() => {
	vi.unstubAllGlobals();
});

test('missing token → 400', async () => {
	const res = await POST(ev({}));
	expect(res.status).toBe(400);
	expect((await res.json()).error).toMatch(/bot token/i);
});

test('malformed token → 400 without calling Telegram', async () => {
	const spy = vi.fn();
	vi.stubGlobal('fetch', spy);
	const res = await POST(ev({ botToken: 'not-a-token' }));
	expect(res.status).toBe(400);
	expect((await res.json()).error).toMatch(/check the bot token/i);
	expect(spy).not.toHaveBeenCalled();
});

test('returns the most recent chat id + name', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			tg(true, {
				ok: true,
				result: [
					{ message: { chat: { id: 111, first_name: 'Old' } } },
					{ message: { chat: { id: 222, first_name: 'Ada', last_name: 'Lovelace' } } }
				]
			})
		)
	);
	const res = await POST(ev({ botToken: '123456:ABC-DEF' }));
	const body = await res.json();
	expect(res.status).toBe(200);
	expect(body.chatId).toBe('222');
	expect(body.name).toBe('Ada Lovelace');
});

test('empty updates → 404 asks the user to message the bot first', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => tg(true, { ok: true, result: [] }))
	);
	const res = await POST(ev({ botToken: '123456:ABC-DEF' }));
	expect(res.status).toBe(404);
	expect((await res.json()).error).toMatch(/recent messages|send your bot/i);
});

test('webhook set (409) → 400 webhook error', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => tg(false, { ok: false, error_code: 409 }, 409))
	);
	const res = await POST(ev({ botToken: '123456:ABC-DEF' }));
	expect(res.status).toBe(400);
	expect((await res.json()).error).toMatch(/webhook/i);
});

test('unauthorized (401) → 400 "check the bot token"', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => tg(false, { ok: false, error_code: 401 }, 401))
	);
	const res = await POST(ev({ botToken: '123456:ABC-DEF' }));
	expect(res.status).toBe(400);
	expect((await res.json()).error).toMatch(/check the bot token/i);
});
