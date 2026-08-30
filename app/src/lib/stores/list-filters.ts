import { writable } from 'svelte/store';

// Client-side persistence of list-page filters across in-app navigation (#141).
// The sidebar nav links are param-less, so URL-param state is lost when you
// navigate away and back via the nav. Module-level stores survive client-side
// navigation (they're not re-created on remount), so a page can restore its
// filters on mount. Only ever written client-side (from user interactions),
// so there's no SSR cross-request leakage.

// Tag filtering now lives inside `q` as a `#tag` token (#142), so there's no
// separate tag field here.
export type MonitorFilters = { q: string; status: string };
export const monitorFilters = writable<MonitorFilters>({ q: '', status: '' });

export type IncidentFilter = 'all' | 'open' | 'resolved';
export const incidentFilter = writable<IncidentFilter>('all');
