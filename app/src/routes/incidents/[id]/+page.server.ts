import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) {
		throw redirect(303, '/signin');
	}

	let record;
	try {
		record = await locals.pb!.collection('incidents').getOne(params.id, { expand: 'monitor' });
	} catch {
		throw error(404, 'Incident not found');
	}

	const m = record.expand?.monitor;
	// Ownership: the incident is only visible if its monitor belongs to the user.
	if (!m || m.user !== locals.user.id) {
		throw error(404, 'Incident not found');
	}

	const events = await locals
		.pb!.collection('incident_events')
		.getFullList({
			filter: `incident="${params.id}"`,
			sort: 'created',
			fields: 'id,type,message,zone,author,created'
		})
		.catch(() => []);

	return {
		events: events.map((e) => ({
			id: e.id,
			type: e.type as string,
			message: e.message as string,
			zone: (e.zone as string) || '',
			author: (e.author as string) || '',
			created: e.created as string
		})),
		incident: {
			id: record.id,
			started_at: record.started_at,
			resolved_at: record.resolved_at || null,
			cause: record.cause || '',
			acknowledged_at: record.acknowledged_at || null,
			acknowledged_by: record.acknowledged_by || '',
			escalated_at: record.escalated_at || null
		},
		monitor: {
			id: m.id,
			name: m.name,
			type: m.type,
			target: m.target,
			interval: m.interval
		}
	};
};
