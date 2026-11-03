import type PocketBase from 'pocketbase';
import { getAvailabilityOverview } from '#lib/server/availability.js';
import { getAccountPlan } from '#lib/server/plan.js';
import { statusPageLimitMessage } from '#lib/plans.js';

// Public status pages (#679). The public page at /s/<slug> is read with the web's
// service account: nobody signs in to see it, and PocketBase grants anonymous
// visitors nothing. So THIS module is what decides what a stranger sees, and it
// returns only what the owner chose: each chosen monitor's name and state, its
// uptime, and when incidents happened. Never a target, a cause, a check's error
// text or anything else from the owner's account.

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const MAX_MONITORS = 50;
const DAY_MS = 86_400_000;

export type StatusPageInput = {
	title: string;
	slug: string;
	description: string;
	monitors: string[];
};

/** Field errors for the manage form, keyed by field name; empty when valid. */
export function validateStatusPage(input: StatusPageInput): Record<string, string> {
	const errors: Record<string, string> = {};
	if (!input.title.trim()) errors.title = 'Give the page a title.';
	else if (input.title.trim().length > 80) errors.title = 'Keep the title to 80 characters.';
	if (!SLUG_PATTERN.test(input.slug)) {
		errors.slug =
			'Use 3 to 40 lowercase letters, digits or dashes, starting and ending with a letter or digit.';
	}
	if (input.description.length > 500)
		errors.description = 'Keep the description to 500 characters.';
	if (input.monitors.length === 0) errors.monitors = 'Choose at least one monitor to show.';
	if (input.monitors.length > MAX_MONITORS)
		errors.monitors = `A page can show up to ${MAX_MONITORS} monitors.`;
	return errors;
}

export function readStatusPageForm(form: FormData): StatusPageInput {
	return {
		title: String(form.get('title') ?? '').trim(),
		slug: String(form.get('slug') ?? '')
			.trim()
			.toLowerCase(),
		description: String(form.get('description') ?? '').trim(),
		monitors: [...new Set(form.getAll('monitors').map(String).filter(Boolean))]
	};
}

/**
 * The ids, of those given, that belong to `userId`. A relation field accepts any
 * monitor id, so without this an owner could put someone else's monitor on their
 * public page.
 */
export async function ownedMonitorIds(
	pb: PocketBase,
	userId: string,
	ids: string[]
): Promise<string[]> {
	if (ids.length === 0) return [];
	const params: Record<string, string> = { u: userId };
	ids.forEach((id, i) => (params[`m${i}`] = id));
	const expr = `user = {:u} && (${ids.map((_, i) => `id = {:m${i}}`).join(' || ')})`;
	const rows = await pb
		.collection('monitors')
		.getFullList({ filter: pb.filter(expr, params), fields: 'id' });
	const owned = new Set(rows.map((r) => r.id));
	return ids.filter((id) => owned.has(id));
}

export type PublicMonitorState = 'up' | 'down' | 'pending' | 'paused';

export type PublicStatusPage = {
	title: string;
	description: string;
	overall: 'up' | 'down' | 'pending';
	monitors: {
		id: string;
		name: string;
		state: PublicMonitorState;
		uptime30d: number | null;
		fromMs: number;
		toMs: number;
		dataStartMs: number;
		down: { s: number; e: number }[];
	}[];
	incidents: { monitor: string; startedAt: string; resolvedAt: string | null }[];
	poweredBy: boolean;
	generatedAt: number;
};

function stateOf(m: Record<string, unknown>): PublicMonitorState {
	if (m.enabled === false) return 'paused';
	if (m.status === 'up' || m.status === 'down') return m.status;
	return 'pending';
}

/** The public view of a page, or null when no page has that slug. */
export async function loadPublicStatusPage(
	pb: PocketBase,
	slug: string,
	now: Date = new Date()
): Promise<PublicStatusPage | null> {
	if (!SLUG_PATTERN.test(slug)) return null;
	const found = await pb
		.collection('status_pages')
		.getList(1, 1, { filter: pb.filter('slug = {:s}', { s: slug }) });
	const page = found.items[0];
	if (!page) return null;

	const owner = page.user as string;
	const chosen = (page.monitors as string[] | undefined) ?? [];
	// Ownership is checked again here, not only when the page is saved: the page
	// is public, so this is the last place a wrong id could still leak.
	const ids = await ownedMonitorIds(pb, owner, chosen.slice(0, MAX_MONITORS));
	const rows =
		ids.length === 0
			? []
			: await pb.collection('monitors').getFullList({
					filter: pb.filter(
						`user = {:u} && (${ids.map((_, i) => `id = {:m${i}}`).join(' || ')})`,
						Object.fromEntries([['u', owner], ...ids.map((id, i) => [`m${i}`, id])])
					),
					fields: 'id,name,status,enabled'
				});
	const byId = new Map(rows.map((r) => [r.id, r]));
	const ordered = ids.map((id) => byId.get(id)).filter((r) => r !== undefined);

	const monitors = await Promise.all(
		ordered.map(async (m) => {
			const ranges = await getAvailabilityOverview(pb, m.id, now);
			const r30 = ranges.find((r) => r.key === '30d')!;
			return {
				id: m.id,
				name: String(m.name ?? ''),
				state: stateOf(m),
				uptime30d: r30.availability,
				fromMs: r30.fromMs,
				toMs: r30.toMs,
				dataStartMs: r30.dataStartMs,
				down: r30.down
			};
		})
	);

	const names = new Map(monitors.map((m) => [m.id, m.name]));
	let incidents: PublicStatusPage['incidents'] = [];
	if (monitors.length > 0) {
		const since = new Date(now.getTime() - 30 * DAY_MS).toISOString().replace('T', ' ');
		const params: Record<string, string> = { since };
		monitors.forEach((m, i) => (params[`m${i}`] = m.id));
		const list = await pb.collection('incidents').getList(1, 20, {
			filter: pb.filter(
				`started_at >= {:since} && (${monitors.map((_, i) => `monitor = {:m${i}}`).join(' || ')})`,
				params
			),
			sort: '-started_at',
			// Only times: `cause` holds the check's error text, which can name hosts,
			// ports or internal addresses the owner never chose to publish.
			fields: 'monitor,started_at,resolved_at'
		});
		incidents = list.items.map((i) => ({
			monitor: names.get(i.monitor as string) ?? '',
			startedAt: i.started_at as string,
			resolvedAt: (i.resolved_at as string) || null
		}));
	}

	const users = await pb
		.collection('users')
		.getList(1, 1, { filter: pb.filter('id = {:id}', { id: owner }), fields: 'id,created' });
	const { plan } = await getAccountPlan(pb, {
		id: owner,
		created: (users.items[0]?.created as string | undefined) ?? null
	});

	const states = monitors.map((m) => m.state).filter((s) => s !== 'paused');
	const overall: PublicStatusPage['overall'] = states.includes('down')
		? 'down'
		: states.length > 0 && states.every((s) => s === 'up')
			? 'up'
			: 'pending';

	return {
		title: String(page.title ?? ''),
		description: String(page.description ?? ''),
		overall,
		monitors,
		incidents,
		poweredBy: plan.statusPageFooter,
		generatedAt: now.getTime()
	};
}

export type SaveResult =
	| { ok: true; id: string }
	| { ok: false; status: number; message: string; errors: Record<string, string> };

/** PocketBase answers a taken slug with a field error on `slug`. */
function slugTaken(err: unknown): boolean {
	const data = (err as { data?: { data?: Record<string, { code?: string }> } })?.data?.data;
	return !!data?.slug;
}

/**
 * Create or update one of the user's pages (#679). `pb` is the user's own client.
 * Monitors that are not the user's are dropped, and a new page past the plan's
 * page count is refused (counted again after the insert, as for monitors).
 */
export async function saveStatusPage(
	pb: PocketBase,
	user: { id: string; created?: string | null },
	input: StatusPageInput,
	id?: string
): Promise<SaveResult> {
	const errors = validateStatusPage(input);
	if (Object.keys(errors).length) {
		return { ok: false, status: 400, message: 'Check the highlighted fields.', errors };
	}
	const monitors = await ownedMonitorIds(pb, user.id, input.monitors);
	if (monitors.length === 0) {
		return {
			ok: false,
			status: 400,
			message: 'Check the highlighted fields.',
			errors: { monitors: 'Choose at least one of your monitors to show.' }
		};
	}
	const body = {
		title: input.title,
		slug: input.slug,
		description: input.description,
		monitors,
		user: user.id
	};
	const count = async () =>
		(
			await pb
				.collection('status_pages')
				.getList(1, 1, { filter: pb.filter('user = {:u}', { u: user.id }), fields: 'id' })
		).totalItems;

	try {
		if (id) {
			const rec = await pb.collection('status_pages').update(id, body);
			return { ok: true, id: rec.id };
		}
		const { plan } = await getAccountPlan(pb, user);
		const refusal = (): SaveResult => ({
			ok: false,
			status: 402,
			message: statusPageLimitMessage(plan),
			errors: {}
		});
		if ((await count()) >= plan.statusPages) return refusal();
		const rec = await pb.collection('status_pages').create(body);
		if ((await count()) > plan.statusPages) {
			await pb.collection('status_pages').delete(rec.id);
			return refusal();
		}
		return { ok: true, id: rec.id };
	} catch (err) {
		if (slugTaken(err)) {
			return {
				ok: false,
				status: 400,
				message: 'Check the highlighted fields.',
				errors: { slug: 'That address is already taken. Try another.' }
			};
		}
		throw err;
	}
}
