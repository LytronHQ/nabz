import { test, expect } from '@playwright/test';

// Layout checks for the public pages, at a phone and a desktop width (#695). A
// screenshot of the part a PR changed missed the landing page's top bar breaking
// on phones: links wrapped onto two lines, "Get started" ran into the edge and the
// theme toggle was pushed off the screen. These checks look at every page's top
// bar, whatever the PR was about.

const PAGES = [
	'/',
	'/pricing',
	'/tools',
	'/tools/website',
	'/compare/uptimerobot',
	'/compare/better-stack',
	'/terms',
	'/privacy',
	'/refunds',
	'/changelog',
	'/signin',
	'/signup'
];
// A centred card with no top bar: only the overflow check applies.
const NO_TOP_BAR = new Set(['/signin', '/signup']);
const WIDTHS = [390, 1280];

for (const width of WIDTHS) {
	for (const path of PAGES) {
		test(`${path} at ${width}px: no sideways scroll, top bar on one line and on screen`, async ({
			page
		}) => {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(path);
			await page.waitForLoadState('networkidle');

			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth
			);
			// Soft, so the top-bar problems below are reported in the same run.
			expect.soft(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0);
			if (NO_TOP_BAR.has(path)) return;

			// The first header on the page: the top bar of every public page.
			const problems = await page.evaluate((vw) => {
				const header = document.querySelector('header');
				if (!header) return ['no <header> on the page'];
				const out: string[] = [];
				const items = [...header.querySelectorAll('a, button')].filter((el) => {
					const r = (el as HTMLElement).getBoundingClientRect();
					const st = getComputedStyle(el);
					return r.width > 0 && r.height > 0 && st.visibility !== 'hidden';
				});
				if (items.length === 0) out.push('the top bar has no visible links or buttons');
				for (const el of items) {
					const r = el.getBoundingClientRect();
					const name = (el.textContent || el.getAttribute('aria-label') || el.tagName).trim();
					if (r.left < -1 || r.right > vw + 1) {
						out.push(
							`"${name}" is off screen (${Math.round(r.left)}–${Math.round(r.right)} of ${vw})`
						);
					}
					// A label that wraps has text on more than one line box. Text nodes
					// only: an icon's SVG shapes sit at other heights and are not lines.
					const tops: number[] = [];
					const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
					for (let n = walker.nextNode(); n; n = walker.nextNode()) {
						if (!n.textContent?.trim()) continue;
						const range = document.createRange();
						range.selectNodeContents(n);
						for (const rect of range.getClientRects()) if (rect.width > 0) tops.push(rect.top);
					}
					const lines = tops
						.sort((x, y) => x - y)
						.filter((t, i, all) => i === 0 || t - all[i - 1] > 4).length;
					if (lines > 1) out.push(`"${name}" wraps onto ${lines} lines`);
				}
				return out;
			}, width);
			expect(problems, 'top bar problems').toEqual([]);
		});
	}
}
