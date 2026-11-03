import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { serviceClient } from '#lib/server/service-pb.js';
import { loadPublicStatusPage } from '#lib/server/status-pages.js';

// The public status page (#679). No sign-in; what it shows is decided entirely
// by loadPublicStatusPage, which returns only what the owner chose.
export const load: PageServerLoad = async ({ params, setHeaders }) => {
	let pb;
	try {
		pb = await serviceClient();
	} catch {
		throw error(503, 'This status page is temporarily unavailable.');
	}
	let page;
	try {
		page = await loadPublicStatusPage(pb, params.slug);
	} catch (err) {
		console.error('status page: load failed', (err as Error)?.message);
		throw error(503, 'This status page is temporarily unavailable.');
	}
	if (!page) throw error(404, 'Not found');
	// Short: a visitor checking during an outage must not see a stale "all up".
	setHeaders({ 'cache-control': 'public, max-age=30' });
	return { page };
};
