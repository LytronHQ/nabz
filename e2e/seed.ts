// The data several specs read but none of them created (#606): a resolved
// incident (accessible-names opens one), monitors and a dependency between them
// (graph-fit draws the map and the dependency graph), an active user and
// several days of day rollups (admin's user counts and checks sparkline).
//
// They used to pass only when an earlier spec, or an earlier run, had left such
// data behind, so on a fresh stack the nightly suite failed six tests every day.
// Seeded once per run from global-setup, through the API, idempotently: each
// record is looked up by a fixed name or key first.

const PB = process.env.E2E_PB || 'http://127.0.0.1:8390';
const SU_EMAIL = process.env.E2E_SUPERUSER_EMAIL || 'admin@e2e.local';
const SU_PASS = process.env.E2E_SUPERUSER_PASSWORD || 'e2e-superuser-pass';
const USER_EMAIL = process.env.E2E_USER_EMAIL || 'user@e2e.local';
const DAY_MS = 86_400_000;

type Rec = { id: string } & Record<string, unknown>;

async function call(token: string, method: string, path: string, body?: unknown) {
	const res = await fetch(`${PB}${path}`, {
		method,
		headers: { Authorization: token, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`seed: ${method} ${path} → ${res.status} ${await res.text()}`);
	return res.json();
}

async function findOrCreate(
	token: string,
	coll: string,
	filter: string,
	data: object
): Promise<Rec> {
	const found = await call(
		token,
		'GET',
		`/api/collections/${coll}/records?perPage=1&filter=${encodeURIComponent(filter)}`
	);
	if (found.items?.length) return found.items[0];
	return call(token, 'POST', `/api/collections/${coll}/records`, data);
}

const pbDate = (t: number) => new Date(t).toISOString().replace('T', ' ');
const startOfDay = (t: number) => Math.floor(t / DAY_MS) * DAY_MS;

export async function seedStack(): Promise<void> {
	const su = await fetch(`${PB}/api/collections/_superusers/auth-with-password`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ identity: SU_EMAIL, password: SU_PASS })
	});
	if (!su.ok) throw new Error(`seed: superuser auth → ${su.status}`);
	const token = (await su.json()).token as string;

	const users = await call(
		token,
		'GET',
		`/api/collections/users/records?perPage=1&filter=${encodeURIComponent(`email = "${USER_EMAIL}"`)}`
	);
	const user = users.items?.[0]?.id as string | undefined;
	if (!user) throw new Error(`seed: no ${USER_EMAIL}`);

	// Long interval: data for pages to draw, not load for the worker.
	const monitor = (name: string, path: string) =>
		findOrCreate(token, 'monitors', `user = "${user}" && name = "${name}"`, {
			user,
			name,
			type: 'website',
			target: `http://fixture:8080${path}`,
			interval: 300,
			enabled: true,
			status: 'pending'
		});
	const shop = await monitor('seed: shop', '/status/200');
	const api = await monitor('seed: api', '/status/200');

	await findOrCreate(token, 'dependencies', `from = "${shop.id}" && to = "${api.id}"`, {
		user,
		from: shop.id,
		to: api.id
	});

	const now = Date.now();
	await findOrCreate(token, 'incidents', `monitor = "${shop.id}" && cause = "seed"`, {
		monitor: shop.id,
		started_at: pbDate(now - 2 * DAY_MS),
		resolved_at: pbDate(now - 2 * DAY_MS + 5 * 60_000),
		cause: 'seed'
	});

	// Three whole past days: the usage page's checks sparkline needs a series.
	for (let d = 3; d >= 1; d--) {
		const bucket = pbDate(startOfDay(now - d * DAY_MS));
		await findOrCreate(
			token,
			'rollups',
			`monitor = "${shop.id}" && period = "day" && bucket_start = "${bucket}"`,
			{
				monitor: shop.id,
				zone: 'e2e',
				period: 'day',
				bucket_start: bucket,
				uptime_pct: 100,
				avg_ms: 40 + d,
				min_ms: 20,
				max_ms: 90,
				check_count: 280 + d * 4,
				incident_count: 0
			}
		);
	}
}
