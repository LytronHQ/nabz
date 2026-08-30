// CHANGELOG.md lives at the repo root (single source of truth). It's imported as
// a raw string at build time; adding entries takes effect on the next build.
import raw from '../../../../CHANGELOG.md?raw';

export type ChangelogEntry = { version: string; date: string; html: string };

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Minimal inline markdown: links, bold, inline code. Everything is HTML-escaped
// first, so only the tags we generate here are ever emitted.
function inline(s: string): string {
	let out = escapeHtml(s);
	out = out.replace(
		/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
		'<a href="$2" rel="noopener noreferrer">$1</a>'
	);
	out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
	out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
	return out;
}

function semverParts(version: string): [number, number, number] {
	const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

// Newest version first. Compares numerically so v0.1.10 sorts above v0.1.9.
export function compareSemverDesc(a: string, b: string): number {
	const pa = semverParts(a);
	const pb = semverParts(b);
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pb[i] - pa[i];
	}
	return 0;
}

// Parse the changelog by `## vX.Y.Z` version headings. Each entry has a secondary
// date line (`_YYYY-MM-DD_`) and `- ` bullets. Returned newest-version-first.
export function parseChangelog(md: string): ChangelogEntry[] {
	const groups: { version: string; date: string; bullets: string[] }[] = [];
	let cur: { version: string; date: string; bullets: string[] } | null = null;
	for (const line of md.split(/\r?\n/)) {
		const heading = line.match(/^##\s+(v\d+\.\d+\.\d+)\b/);
		if (heading) {
			cur = { version: heading[1], date: '', bullets: [] };
			groups.push(cur);
			continue;
		}
		if (!cur) continue;
		// Secondary date line, e.g. `_2026-07-26_` (surrounding underscores optional).
		const date = line.trim().match(/^_?(\d{4}-\d{2}-\d{2})_?$/);
		if (date && !cur.date) {
			cur.date = date[1];
			continue;
		}
		// A non-date status line for an unreleased/in-progress entry, e.g.
		// `_Unreleased — in progress_`. Any fully italic line that isn't a bullet;
		// passed through verbatim (the page renders it as a label, not a <time>).
		const status = line.trim().match(/^_(.+?)_$/);
		if (status && !cur.date) {
			cur.date = status[1].trim();
			continue;
		}
		const bullet = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
		if (bullet) cur.bullets.push(bullet[1]);
	}
	return groups
		.map((g) => ({
			version: g.version,
			date: g.date,
			html: g.bullets.length
				? '<ul>' + g.bullets.map((b) => `<li>${inline(b)}</li>`).join('') + '</ul>'
				: ''
		}))
		.sort((a, b) => compareSemverDesc(a.version, b.version));
}

export const changelogEntries = parseChangelog(raw);
// A single versioned release (v0.1.0) reads as a legitimate first release, so
// the page + landing link show as soon as there's at least one version entry.
export const changelogVisible = changelogEntries.length > 0;
