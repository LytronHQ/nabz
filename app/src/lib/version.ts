// Which web build is running, in the format the Go nodes print (#489). The values
// are compiled in by vite.config.ts from the repo-root VERSION and the commit.

declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;

export const APP_VERSION: string = __APP_VERSION__;
export const APP_COMMIT: string = __APP_COMMIT__.slice(0, 7);

export function formatVersion(version: string, commit: string): string {
	const short = commit.slice(0, 7);
	return short ? `v${version} (${short})` : `v${version}`;
}

export const VERSION_LABEL = formatVersion(APP_VERSION, APP_COMMIT);
