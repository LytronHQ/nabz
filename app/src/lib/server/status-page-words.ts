// Words a public status page may not use in its title or address (#706). A page
// lives on nabz.sh, so without this anyone could publish /s/nabz-status, a fake
// "PayPal is down" page to phish with, or an offensive title under nabz's name.
//
// Matching is by word, not by substring, except for long names that cannot occur
// inside an ordinary word (`INSIDE`). Substring matching on everything would refuse
// "Scunthorpe Water" and "Pineapple Studio".

export type WordGroup = 'nabz' | 'reserved' | 'brand' | 'offensive';
export type WordHit = { group: WordGroup; word: string };

// nabz's own names, refused anywhere in the title or the address.
const NABZ_INSIDE = ['nabz', 'lytron'];

// Words that make an address look like nabz's own page when they are all it has:
// /s/support or /s/admin-login is refused, /s/acme-support is fine.
const RESERVED = new Set([
	'abuse',
	'account',
	'accounts',
	'admin',
	'administrator',
	'api',
	'billing',
	'help',
	'helpdesk',
	'hostmaster',
	'invoice',
	'invoices',
	'login',
	'moderator',
	'official',
	'password',
	'payment',
	'payments',
	'postmaster',
	'root',
	'security',
	'signin',
	'signup',
	'staff',
	'support',
	'system',
	'verify',
	'verification',
	'webmaster'
]);
// Filler that does not make a reserved address someone's own: /s/support-status.
const FILLER = new Set([
	'status',
	'page',
	'the',
	'team',
	'service',
	'services',
	'center',
	'hq',
	'www',
	'app'
]);

// Well-known companies, payment providers and banks: the targets of a fake outage
// page. Long, unambiguous names also match inside a joined word (`paypalstatus`).
const BRAND_INSIDE = [
	'alibaba',
	'americanexpress',
	'anthropic',
	'atlassian',
	'bankofamerica',
	'barclays',
	'betterstack',
	'binance',
	'chatgpt',
	'citibank',
	'cloudflare',
	'coinbase',
	'digitalocean',
	'dropbox',
	'facebook',
	'fedex',
	'github',
	'gitlab',
	'gmail',
	'godaddy',
	'goldmansachs',
	'google',
	'heroku',
	'hetzner',
	'hsbc',
	'icloud',
	'instagram',
	'jpmorgan',
	'linkedin',
	'mastercard',
	'metamask',
	'microsoft',
	'namecheap',
	'natwest',
	'netflix',
	'netlify',
	'office365',
	'openai',
	'paypal',
	'pingdom',
	'reddit',
	'revolut',
	'royalmail',
	'salesforce',
	'santander',
	'shopify',
	'spotify',
	'tiktok',
	'twitter',
	'uptimerobot',
	'vercel',
	'wellsfargo',
	'whatsapp',
	'youtube'
];
// Brands that are also ordinary words or parts of them: whole words only.
const BRAND_WHOLE = new Set([
	'amazon',
	'amex',
	'apple',
	'aws',
	'azure',
	'chase',
	'dhl',
	'discord',
	'ebay',
	'hmrc',
	'ibm',
	'irs',
	'lloyds',
	'monzo',
	'oracle',
	'slack',
	'stripe',
	'telegram',
	'usps',
	'visa'
]);

// Offensive words. Whole words only (a plural "s" or "es" is ignored), apart from a few
// that no ordinary word contains.
const OFFENSIVE_INSIDE = ['fuck', 'nigger', 'nigga', 'faggot', 'porn', 'jizz'];
const OFFENSIVE_WHOLE = new Set([
	'ass',
	'asshole',
	'bastard',
	'bitch',
	'bollocks',
	'chink',
	'cock',
	'cunt',
	'dickhead',
	'fag',
	'hitler',
	'kike',
	'nazi',
	'paedo',
	'pedo',
	'pussy',
	'rape',
	'retard',
	'shit',
	'slut',
	'spic',
	'tranny',
	'twat',
	'wank',
	'wanker',
	'whore'
]);

// Look-alike characters people use to slip a word past a filter.
const LOOKALIKE: Record<string, string> = {
	'0': 'o',
	'1': 'i',
	'3': 'e',
	'4': 'a',
	'5': 's',
	'7': 't',
	'@': 'a',
	$: 's'
};

/** The text's words, lowercased and without accents, as typed and with look-alikes undone. */
function variants(text: string): string[][] {
	const plain = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
	const words = (s: string) => s.split(/[^a-z0-9]+/).filter(Boolean);
	const undone = plain.replace(/[013457@$]/g, (c) => LOOKALIKE[c]);
	return undone === plain ? [words(plain)] : [words(plain), words(undone)];
}

// The word and its singular forms: "bitches" is "bitch", "whores" is "whore".
const forms = (w: string) =>
	w.length > 3 && w.endsWith('s')
		? [w, w.slice(0, -1), ...(w.endsWith('es') ? [w.slice(0, -2)] : [])]
		: [w];

/** The first refused word in `text`, or null. `address` adds the reserved-address rule. */
export function findRefusedWord(text: string, address = false): WordHit | null {
	for (const words of variants(text)) {
		const joined = words.join('');
		for (const w of NABZ_INSIDE) if (joined.includes(w)) return { group: 'nabz', word: w };
		for (const w of OFFENSIVE_INSIDE)
			if (joined.includes(w)) return { group: 'offensive', word: w };
		for (const w of words) {
			if (forms(w).some((f) => OFFENSIVE_WHOLE.has(f))) return { group: 'offensive', word: w };
		}
		for (const w of BRAND_INSIDE) if (joined.includes(w)) return { group: 'brand', word: w };
		for (const w of words) if (BRAND_WHOLE.has(w)) return { group: 'brand', word: w };
		if (address) {
			const own = words.filter((w) => !FILLER.has(w));
			if (own.length > 0 && own.every((w) => RESERVED.has(w)))
				return { group: 'reserved', word: own[0] };
		}
	}
	return null;
}

/** The form message for a refused word in the title or the address. */
export function refusedWordMessage(hit: WordHit, field: 'title' | 'address'): string {
	switch (hit.group) {
		case 'nabz':
			return `"${hit.word}" is the name of this service, so a status page cannot use it.`;
		case 'reserved':
			return `That address is reserved. Add your own name to it, such as acme-${hit.word}.`;
		case 'brand':
			return `A status page cannot use the name of a well-known company ("${hit.word}"), so nobody can pass one off as theirs. If it is your company, write to support@nabz.sh.`;
		case 'offensive':
			return `Pick ${field === 'title' ? 'a title' : 'an address'} without offensive words.`;
	}
}
