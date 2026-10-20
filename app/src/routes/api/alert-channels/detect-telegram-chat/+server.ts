import type { RequestHandler } from '@sveltejs/kit';
import { failIfNoUser } from '#lib/utils/api-utils.js';

// One-click "Detect Chat ID" for Telegram channels (#124). The bot token is used
// server-side only (it reaches Telegram, never a third party). We read the bot's
// recent updates via getUpdates and return the most recent chat that messaged it.
//
// getUpdates gotchas we surface as typed errors:
//   - empty result   → the user hasn't messaged the bot yet (also the fix for a
//                       genuinely empty inbox);
//   - HTTP/err 409    → a webhook is configured; getUpdates can't be used;
//   - HTTP/err 401    → the bot token is wrong.

// The parts of the Bot API's getUpdates reply read below. Telegram's body is
// untrusted JSON, so every field is optional and each access stays guarded.
type TelegramChat = {
	id?: number | string | null;
	title?: string;
	first_name?: string;
	last_name?: string;
	username?: string;
};
type TelegramUpdate = {
	message?: { chat?: TelegramChat };
	channel_post?: { chat?: TelegramChat };
	my_chat_member?: { chat?: TelegramChat };
	edited_message?: { chat?: TelegramChat };
};
type TelegramResponse = {
	ok?: boolean;
	error_code?: number;
	description?: string;
	result?: unknown;
};

export const POST: RequestHandler = async ({ locals, request }) => {
	failIfNoUser(locals);

	const body = await request.json().catch(() => ({}));
	const botToken = (body?.botToken ?? '').toString().trim();
	if (!botToken) {
		return Response.json({ error: 'Enter the bot token first' }, { status: 400 });
	}
	// Shape check — also guarantees the token is URL-path-safe (digits, ':', word
	// chars, '-'), so it can go into the Telegram URL unescaped without injection.
	if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
		return Response.json({ error: 'Check the bot token' }, { status: 400 });
	}

	let res: Response;
	try {
		res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`, {
			signal: AbortSignal.timeout(8000)
		});
	} catch {
		return Response.json({ error: 'Could not reach Telegram — try again' }, { status: 502 });
	}

	const data: TelegramResponse | null = await res.json().catch(() => ({}));
	if (!res.ok || data?.ok === false) {
		const code = res.status || data?.error_code;
		if (code === 401) return Response.json({ error: 'Check the bot token' }, { status: 400 });
		if (code === 409) {
			return Response.json(
				{
					error:
						'A webhook is set on this bot — remove it (or use @userinfobot) to detect the Chat ID'
				},
				{ status: 400 }
			);
		}
		return Response.json(
			{ error: data?.description || 'Telegram request failed' },
			{ status: 400 }
		);
	}

	const updates: (TelegramUpdate | null)[] = Array.isArray(data?.result) ? data.result : [];
	// Walk newest-first; take the first update that carries a chat.
	for (let i = updates.length - 1; i >= 0; i--) {
		const u = updates[i] ?? {};
		const chat =
			u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat ?? u.edited_message?.chat;
		if (chat?.id != null) {
			const name =
				chat.title ||
				[chat.first_name, chat.last_name].filter(Boolean).join(' ') ||
				chat.username ||
				'';
			return Response.json({ chatId: String(chat.id), name });
		}
	}

	return Response.json(
		{
			error: 'No recent messages — send your bot “/start” (or any message) in Telegram, then Detect'
		},
		{ status: 404 }
	);
};
