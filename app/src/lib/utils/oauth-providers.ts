// Display names for the OAuth providers PocketBase can have on (#609, #622).
const LABELS: Record<string, string> = { github: 'GitHub', google: 'Google' };

export function providerLabel(name: string): string {
	return LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}
