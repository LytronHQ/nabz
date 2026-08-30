import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { serviceClient } from '$lib/server/service-pb';

// The anonymous "try it" detail page (#271). A signed-out visitor views the
// monitor they just created; it's authorized by their signed anon_session cookie
// (locals.anonSession), read server-side via the web service account. A row that's
// gone (past the 1h TTL, or migrated on signup) shows a friendly "expired" state;
// a session that doesn't own the row is a plain 404 (no leaking other trials).
export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.anonSession) {
		throw error(404, 'Not found');
	}

	let pb;
	try {
		pb = await serviceClient();
	} catch {
		throw error(503, 'The trial is temporarily unavailable.');
	}

	let row;
	try {
		row = await pb.collection('anon_monitors').getOne(params.id);
	} catch {
		// Not found — almost always an expired/migrated trial for this visitor.
		return { expired: true, monitor: null };
	}

	if (row.session !== locals.anonSession) {
		throw error(404, 'Not found');
	}

	return {
		expired: false,
		monitor: {
			id: row.id,
			name: row.name,
			target: row.target,
			type: row.type,
			status: row.status,
			interval: row.interval,
			last_checked: row.last_checked,
			created: row.created
		}
	};
};
