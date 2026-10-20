import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const staticDir = resolve(__dirname, '../static');
const manifest = JSON.parse(readFileSync(resolve(staticDir, 'manifest.webmanifest'), 'utf8')) as {
	icons: { src: string; sizes: string; type: string; purpose?: string }[];
	display: string;
	display_override?: string[];
};

// PNG width and height sit at fixed offsets in the IHDR chunk.
function pngSize(file: string): [number, number] {
	const buf = readFileSync(file);
	return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe('PWA manifest', () => {
	// Without a maskable icon, Android shrinks the installed icon onto a white
	// circle instead of filling the launcher shape (#601).
	it('has a 512x512 maskable PNG icon that exists', () => {
		expect(manifest.icons.length).toBeGreaterThan(0);
		const maskable = manifest.icons.filter((i) =>
			(i.purpose ?? 'any').split(' ').includes('maskable')
		);
		expect(maskable).toHaveLength(1);
		const icon = maskable[0];
		expect(icon.type).toBe('image/png');
		expect(icon.sizes).toBe('512x512');
		expect(pngSize(resolve(staticDir, icon.src.replace(/^\//, '')))).toEqual([512, 512]);
	});

	it('keeps an "any" icon for browsers that do not mask', () => {
		expect(manifest.icons.some((i) => (i.purpose ?? 'any').split(' ').includes('any'))).toBe(true);
	});

	// Desktop installs drop the browser's title bar; the app draws its own strip
	// (+layout.svelte, app.css). Everywhere the overlay is not supported, the
	// window falls back to "display", which must stay standalone.
	it('asks for the window controls overlay, falling back to standalone', () => {
		expect(manifest.display_override).toEqual(['window-controls-overlay']);
		expect(manifest.display).toBe('standalone');
	});
});
