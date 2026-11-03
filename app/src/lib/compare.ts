// "nabz vs …" pages (#683). Every figure about another product is copied from that
// product's own page, with the URL and the day it was read, and the page shows
// both. Prices and limits change: re-read the sources and update CHECKED_ON before
// editing a number, never from memory. nabz's own figures come from plans.ts.
//
// Positioning (owner, 2026-11-03): lead with open source and price. Confirming an
// outage from several locations is NOT unique to nabz; both products below do it
// too, so these pages never present it as something they lack.

export const CHECKED_ON = '2026-11-03';

export type CompetitorPlan = { name: string; price: string; facts: string[] };

export type Competitor = {
	slug: string;
	name: string;
	pricingUrl: string;
	plans: CompetitorPlan[];
	/** Where they are ahead, stated plainly: a comparison that hides it is an ad. */
	ahead: string[];
	/** What they say about confirming downtime from several locations, with a source. */
	confirmation: { text: string; url: string };
};

export const COMPETITORS: Competitor[] = [
	{
		slug: 'uptimerobot',
		name: 'UptimeRobot',
		pricingUrl: 'https://uptimerobot.com/pricing/',
		plans: [
			{
				name: 'Free',
				price: '$0',
				facts: ['50 monitors', '5-minute checks', 'Basic status pages', 'Only 5 integrations']
			},
			{
				name: 'Solo',
				price: '$13 a month ($12 billed annually)',
				facts: ['10 monitors', '60-second checks', '3 status pages, own domain']
			},
			{
				name: 'Team',
				price: '$46 a month ($39 billed annually)',
				facts: ['100 monitors', '30-second checks', '3 seats', '100 status pages, white-label']
			}
		],
		ahead: [
			'Its Free plan has 50 monitors; nabz Free has 10.',
			'Status pages on your own domain, from its Solo plan; nabz does not offer that yet.',
			'Checks from more locations than nabz, which runs from two zones today.'
		],
		confirmation: {
			text: 'When a check fails, UptimeRobot re-checks it from a different data center in the same region before opening an incident.',
			url: 'https://uptimerobot.com/'
		}
	},
	{
		slug: 'better-stack',
		name: 'Better Stack',
		pricingUrl: 'https://betterstack.com/pricing',
		plans: [
			{
				name: 'Free',
				price: '$0, for personal projects',
				facts: ['10 monitors and heartbeats', '1 status page', 'Slack and email alerts']
			},
			{
				name: 'Paid',
				price: 'From $29 a month',
				facts: [
					'Additional 50 monitors: $25 a month ($21 billed annually)',
					'Checks as often as every 30 seconds'
				]
			}
		],
		ahead: [
			'Phone-call alerts (unlimited for one responder, even on the free plan), which nabz does not have.',
			'Error tracking in the same product (100,000 exceptions a month free).',
			'Checks from at least 4 locations by default; nabz runs from two zones today.'
		],
		confirmation: {
			text: 'Better Stack checks every monitor from at least 4 locations and opens an incident only after at least 3 fail.',
			url: 'https://betterstack.com/docs/uptime/locations-and-regions/'
		}
	}
];

export const competitorBySlug = (slug: string) => COMPETITORS.find((c) => c.slug === slug);
