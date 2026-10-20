// The installed desktop app's window buttons (window-controls-overlay, #635) are
// painted by the browser in the page's theme-color. The <meta> tags pick that by
// the OS's light/dark setting, but nabz has its own theme toggle: with the OS
// dark and nabz set to light, the buttons sat on a dark block beside a white
// strip. In that mode, give theme-color the strip's real colour, and keep it in
// step with the toggle, the accent and the OS setting.

const OVERLAY = '(display-mode: window-controls-overlay)';

export function syncThemeColor(doc: Document = document, win: Window = window): boolean {
	if (!win.matchMedia?.(OVERLAY).matches) return false;
	const strip = doc.querySelector('.app-titlebar');
	if (!strip) return false;
	const colour = win.getComputedStyle(strip).backgroundColor;
	if (!colour) return false;
	for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
		meta.content = colour;
	}
	return true;
}

/** Keeps theme-color in step; returns the cleanup. */
export function watchThemeColor(doc: Document = document, win: Window = window): () => void {
	const sync = () => syncThemeColor(doc, win);
	sync();
	// The toggle and the accent picker write attributes on <html>.
	const observer = new MutationObserver(sync);
	observer.observe(doc.documentElement, { attributes: true });
	const queries = [OVERLAY, '(prefers-color-scheme: dark)']
		.map((q) => win.matchMedia?.(q))
		.filter((m): m is MediaQueryList => !!m && typeof m.addEventListener === 'function');
	for (const m of queries) m.addEventListener('change', sync);
	return () => {
		observer.disconnect();
		for (const m of queries) m.removeEventListener('change', sync);
	};
}
