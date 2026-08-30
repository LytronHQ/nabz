import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { DefaultPageSize } from '$lib/constants';
import { AlertChannelItem } from '$lib/models/alert-channel';
import { channelDisplayName } from '$lib/utils/channel-display';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		throw redirect(303, '/signin');
	}

	const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
	// Policies paginate; the channel list stays full — the editor needs every
	// channel to pick from.
	const [policyRes, channels] = await Promise.all([
		locals
			.pb!.collection('escalation_policies')
			.getList(page, DefaultPageSize, {
				filter: `user="${locals.user.id}"`,
				sort: 'name',
				fields: 'id,name,steps'
			})
			.catch(() => null),
		locals
			.pb!.collection('alert_channels')
			.getFullList({
				filter: `user="${locals.user.id}"`,
				sort: '-created',
				fields: 'id,type,target,config,name,enabled'
			})
			.catch(() => [])
	]);
	const policies = policyRes?.items ?? [];

	return {
		pagination: {
			current: policyRes?.page ?? 1,
			size: policyRes?.perPage ?? DefaultPageSize,
			totalItems: policyRes?.totalItems ?? 0
		},
		policies: policies.map((p) => ({
			id: p.id,
			name: p.name as string,
			steps: (Array.isArray(p.steps) ? p.steps : []) as {
				after_minutes: number;
				channels: string[];
			}[]
		})),
		channels: channels.map((c) => {
			// Resolve config -> flat fields so the label uses the real destination,
			// then prefer the channel's Name (falls back to "provider · target").
			const item = new AlertChannelItem(c);
			return {
				id: c.id,
				type: c.type as string,
				enabled: !!c.enabled,
				name: item.name,
				label: channelDisplayName(item)
			};
		})
	};
};
