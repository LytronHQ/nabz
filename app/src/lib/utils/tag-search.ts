// Monitors search understands `#tag` tokens (#142): every `#word` in the search
// string is a tag filter (minus the `#`), ANDed together; the remaining words are
// the free-text query. Clicking a tag anywhere toggles its `#token` in the search.

export function parseTagSearch(text: string): { q?: string; tags: string[] } {
	const tokens = (text ?? '').split(/\s+/).filter(Boolean);
	const tags: string[] = [];
	const rest: string[] = [];
	for (const t of tokens) {
		if (t.length > 1 && t.startsWith('#')) {
			const tag = t.slice(1);
			if (!tags.includes(tag)) tags.push(tag);
		} else {
			rest.push(t);
		}
	}
	return { q: rest.join(' ').trim() || undefined, tags };
}

/** Toggle `#tag` in a search string: append it if absent, remove it if present. */
export function toggleTag(search: string, tag: string): string {
	const token = `#${tag}`;
	const tokens = (search ?? '').split(/\s+/).filter(Boolean);
	const idx = tokens.indexOf(token);
	if (idx >= 0) tokens.splice(idx, 1);
	else tokens.push(token);
	return tokens.join(' ');
}
