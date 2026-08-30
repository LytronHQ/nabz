import { json, type RequestHandler } from '@sveltejs/kit';

// Distinct tags across the signed-in user's monitors, for the Monitors quick-filter
// list (#142). Lightweight — fetches only the `tags` field. The `monitors` list rule
// already scopes to the caller; the explicit filter is belt-and-suspenders.
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return json({ tags: [] });
	const rows = await locals.pb!.collection('monitors').getFullList({
		filter: locals.pb!.filter('user = {:user}', { user: locals.user.id }),
		fields: 'tags'
	});
	const set = new Set<string>();
	for (const r of rows) for (const t of (r as { tags?: string[] }).tags ?? []) set.add(t);
	return json({ tags: [...set].sort((a, b) => a.localeCompare(b)) });
};
