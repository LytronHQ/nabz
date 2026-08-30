// Turn Playwright's JSON report into a GitHub Actions run summary (a markdown
// table of every test, its status and time). The e2e workflow runs this after
// the tests and appends the output to $GITHUB_STEP_SUMMARY, so the run's summary
// page shows what passed/failed at a glance. Also prints to stdout for local use.
//
//   node summary.mjs [results.json]
import fs from 'node:fs';

const reportPath = process.argv[2] || 'results.json';
if (!fs.existsSync(reportPath)) {
	console.error(`summary: no report at ${reportPath}`);
	process.exit(0); // don't fail the job just because there's no report
}
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

// Walk the suite tree (files → describe blocks → specs), collecting each spec
// with the file it lives in, its final status, and total time across attempts.
const rows = [];
function walk(suites, fileHint) {
	for (const suite of suites ?? []) {
		const file = suite.file || fileHint || '';
		for (const spec of suite.specs ?? []) {
			const t = spec.tests?.[0];
			const status = t?.status ?? (spec.ok ? 'expected' : 'unexpected');
			const duration = (t?.results ?? []).reduce((a, r) => a + (r.duration || 0), 0);
			const attempts = (t?.results ?? []).length;
			rows.push({ file: file.split('/').pop(), title: spec.title, status, duration, attempts });
		}
		walk(suite.suites, file);
	}
}
walk(report.suites);

const ICON = { expected: '✅', unexpected: '❌', flaky: '⚠️', skipped: '⏭️' };
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const s = report.stats ?? {};

let out = '## e2e results\n\n';
const bits = [
	`**${s.expected ?? 0} passed**`,
	`${s.unexpected ?? 0} failed`,
	`${s.flaky ?? 0} flaky`,
	`${s.skipped ?? 0} skipped`
];
out += `${bits.join(' · ')} — in ${secs(s.duration ?? 0)}\n\n`;
out += '| | Test | File | Time |\n|:-:|---|---|--:|\n';
for (const r of rows) {
	const note = r.status === 'flaky' && r.attempts > 1 ? ` _(retried)_` : '';
	out += `| ${ICON[r.status] ?? '•'} | ${r.title}${note} | \`${r.file}\` | ${secs(r.duration)} |\n`;
}

process.stdout.write(out);
if (process.env.GITHUB_STEP_SUMMARY) {
	fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out);
}
