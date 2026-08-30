# Changelog

Notable changes to nabz. Newest first.

## v0.11.1

_2026-08-30_

- **nabz is open source** — the code is now public under the **AGPL-3.0** at [LytronHQ/nabz](https://github.com/LytronHQ/nabz), with a README that explains what self-hosting includes and where the hosted service fits. AGPL specifically: it is the licence that keeps a hosted fork's changes available.
- **A self-hoster can now start from an example** — the deploy configuration ships an `example.vars` with every key commented, rather than leaving you to infer the shape from the scripts.
- No product changes. Everything else here is repository and release plumbing: publishing each release to the public repo automatically, and a pile of dead links repointed after the rename.

## v0.11.0

_2026-08-30_

- **Response-time charts you can actually read** — the y-axis no longer lets a single timeout flatten everything else: an outlier is capped and marked at the top edge rather than setting the scale for the whole chart. Lines are smoothed with monotone curves that pass through every measurement without inventing dips between them, and if you've set a slow-alert threshold it's drawn on the chart so you can see how close you're running to it.
- **Status dots that beat** — up, down and pending now pulse, in their own colour. Paused deliberately doesn't: it's the one state that genuinely isn't beating.
- **Per-region detail you can trust** — the "By zone" cards show each region's *latest* check rather than its oldest, so a monitor reading Up no longer shows regions stuck on a failure they recovered from long ago. A brand-new monitor also reports real availability straight away instead of a dash.
- **Several workers per region** — a region can now run any number of workers, on one machine or spread across several sharing a queue. One worker per region seeds the schedule, and the live worker count is visible on the admin view. Region *codes* are now separate from their display names, so renaming a region is a label change rather than a data migration.
- **Sign-in accounts out of the box** — every environment is provisioned with an admin and a regular user, and neither can keep its seeded password: the first sign-in must change it before anything else is reachable.
- **Faster dashboard** — the three unbounded counts behind the dashboard now read from pre-aggregated rollups, cutting the rows scanned per monitor per day from 2,880 to 48 without changing a single figure.
- **Backups that have been restored, not just taken** (under the hood) — a nightly maintenance run checkpoints and compacts the database before backing it up to object storage, and the restore path has been rehearsed end to end rather than assumed.
- **Self-hosted, fully scripted infrastructure** (under the hood) — the fleet now provisions from scratch with one workflow: servers, private networking, a tunnel with access control in front of the database, and the web app on Cloudflare Workers. Along with it, a long list of fixes to the deployment path itself, each one found by actually running it.

## v0.10.0

_2026-08-07_

- **See when a monitor last went down** — the monitors list has a new "Last downtime" column showing each monitor's most recent incident (or "No incidents recorded"), so a monitor that's been green for months is easy to tell apart from one that just recovered.
- **Monitor map refinements** — search the map to highlight matching monitors, a live node counter, a Compact/Wide layout toggle, a 24h-uptime figure under each node, and a completed colour legend.

## v0.9.0

_2026-08-03_

- **Renamed to nabz** — same product, new name (Persian for _pulse_, which is exactly what the logo mark already draws) and a new home at nabz.sh. Purely a rename: no behaviour change, no new features.
- **Try it without signing up** — start one monitor straight from the landing page and watch it go from pending to up/down live, no account needed. Anonymous trials run in an isolated zone and expire after an hour; sign up and your monitor moves into your account, kept for good. The full detail view is shown with the richer widgets locked behind sign-up.

## v0.8.0

_2026-08-02_

- **Public health endpoint** — a single internet-facing `/api/health` reporting the fleet's status, aggregated from the datastore alone so it still answers when a node is down. A liveness heartbeat finally makes a dead evaluator detectable — the one failure nothing else could catch.
- **PagerDuty incidents auto-resolve on recovery** — a stable dedup key ties the resolve to the trigger, so a recovered monitor closes its PagerDuty incident instead of leaving it open, and escalation no longer opens a duplicate incident per level.
- **Removed Opsgenie** as an alert channel — Atlassian is discontinuing it, so it's no longer offered.
- **Admin usage dashboard** — a private, at-a-glance view of whether the product is being used and growing.
- **Polish & hardening (under the hood)** — the dashboard's Zones card no longer exposes internal operational detail; refreshed branding and social-preview assets; and the real-stack end-to-end suite now covers actual alert delivery across webhook, Slack, Telegram, Discord, and PagerDuty.

## v0.7.0

_2026-08-01_

- Dependency graph + blast radius — map which of your monitors depend on others ("API depends on Database"), shown as a directional graph. When a monitor goes down, everything that transitively depends on it is highlighted in amber, so you can see the blast radius at a glance. Reachable from the new Monitors sub-nav (List · Map · Dependencies).
- Self-monitoring (under the hood) — the worker and evaluator now serve two-tier health endpoints: a minimal public `ok`/`degraded`, and a token-gated debug tier that reports which dependency is unhealthy and since when — scrubbed so it never exposes a target, credential, or raw error — plus the deployed version and commit.
- Quality (under the hood) — the beginnings of a real-stack, black-box end-to-end test suite (Playwright against a full ephemeral fleet — PocketBase + worker + evaluator + web), run on demand and nightly, separate from the fast per-PR unit tests.

## v0.6.0

_2026-07-31_

- Monitor map — a force-directed graph view of your monitors, grouped by tag or by domain, so overlapping tags form one interconnected web instead of a flat list. Hover a node for its status and a link through to the monitor; drag, pan, and zoom. The first genuine feature after the v0.5.0 foundations.
- Automated releases (under the hood) — GitHub Releases are now published automatically when a version tag is pushed, with the notes taken from this changelog.

## v0.5.0

_2026-07-31_

- Under the hood — a foundations release with no change to how the app looks or behaves. The UI now runs entirely on one design-token system: the last Flowbite/Tailwind widgets (form dropdowns, toggles, dialogs, alerts, pagination) were replaced with token-based equivalents, and repeated patterns (empty states, "Add" buttons, form-submit and background-refresh helpers) were consolidated into shared components.
- Continuous integration — every change now runs the full app and Go test suites with coverage on GitHub Actions, and the README shows live build-status and per-suite coverage badges.
- Housekeeping — an index on the busiest database query, a single place that resolves a monitor's alert recipients, and assorted internal cleanups.

## v0.4.0

_2026-07-31_

- New look — "Blueprint": a cleaner, denser design with an engineering-drawing feel — hairline and dashed dividers in place of drop shadows, tighter corners, a deep petrol accent, and sharper typography (Inter throughout, with Space Grotesk for the headline numbers like uptime and response times). It replaces the interim soft-card look; both light and dark themes and the accent-colour picker carry through.
- Works on your phone — nabz is now fully responsive across phone, tablet, and desktop: the sidebar collapses to a slide-out drawer, data tables scroll within their card instead of squishing, dialogs and toolbars fit narrow screens, and the landing and sign-in pages lay out cleanly on mobile.
- Domain-expiry monitoring — get warned before a monitored domain's **registration** lapses, separate from its TLS certificate. nabz looks the date up quietly in the background (RDAP, falling back to WHOIS) and shows it on the monitor page beside the SSL certificate — so a forgotten renewal doesn't quietly take your site down.
- Availability at a glance — the monitor page now leads with an uptime bar that shows green/red across the last 24 hours, 7, or 30 days, so you can see exactly when a service was down, alongside its uptime %, downtime, and incident count for that range. The full multi-window breakdown (Today, 7 / 30 / 365 days, and all-time, plus a custom From/To range) stays below for the complete history.
- A tidier monitor page — the fixed facts (uptime, response, interval, and SSL + domain expiry) now sit together in one compact summary strip at the top instead of a long stack of separate cards, so the page is shorter and easier to scan. It reflows cleanly on phones.

## v0.3.0

_2026-07-28_

- New look — a refreshed, cleaner visual design: white "soft-card" panels floating on a light neutral background with gentle shadows, a calm-green accent, and Inter for readable text (monospace kept for URLs, numbers, and technical data). Both light and dark themes and the accent-colour picker flow from the new system.
- Account page — manage your profile from a new Account screen (reachable from the sidebar): change your password, request a reset, change your email (with verification), and set a display name and avatar.
- List filters now persist as you navigate — filter the Monitors list (search, status, or a tag) or the Incidents view (open/resolved), leave the page, and it's still applied when you return. Filtering also shows a brief "working" indicator while results load.
- Add and edit a monitor on a roomy dedicated page instead of a cramped dialog, with room for all the options.
- Tags overhaul — add tags as pills while editing a monitor, filter the list by tapping a tag chip (or typing a `#tag` in search), and jump straight to a tag's monitors from the detail page.
- Alert channels can now carry an optional name — shown in your escalation policies and the channels list — and long targets like webhook URLs display in full in a multi-line field.
- Alert channels show inline "how to get this" help for each type — Slack and Discord webhooks, a Telegram bot token + Chat ID, and a PagerDuty routing key — with a link to each provider's docs.
- Telegram channels get a one-click **Detect Chat ID** — message your bot, click Detect, and nabz fills in the Chat ID for you.
- The monitor page shows a live "next check in …" countdown, so you know when the next probe is due.
- Redirect transparency — a check that followed redirects now shows how many it followed and the final URL, so a redirect to the wrong host or an `https → http` downgrade is visible in the monitor's recent checks.

## v0.2.2

_2026-07-28_

- Fixed: heartbeat check-ins now reliably record their history. A check-in always updated the monitor's status, but on some setups (notably production / self-hosted) the per-check-in record could be silently dropped — leaving a heartbeat monitor's check-in log and uptime empty. Check-ins now record regardless of how the receiving node is configured.

## v0.2.1

_2026-07-27_

- Fixed: the monitors list no longer flashes empty for a moment when you open it — it's rendered on the server, so your monitors are there immediately (including right after creating one).
- Fixed: opening a just-created monitor no longer briefly shows a stale "Pending / no checks" state before catching up — the detail page loads fresh on navigation.
- Incidents list now paginates — incidents past the first page are reachable (previously capped at 100), and the open/resolved filter applies across all of them, not just the current page.
- Pagination across the remaining lists — the alert channels list, a channel's delivery log, escalation policies, and a monitor's recent-checks table all page now, so none is stuck showing only the first slice.
- The Dashboard's "Add monitor" button now opens the create form right where you are, instead of jumping to the Monitors page first.
- Form placeholders are now clearly muted, so an empty field is easy to tell from one you've filled in.
- Dark mode now covers modals and their forms — the Add/Edit monitor, alert-channel, and escalation dialogs render dark to match the rest of the app instead of staying a bright white box.

## v0.2.0

_2026-07-27_

- Ping monitors — check a host's TCP reachability (connects on :443 by default, or specify `host:port`) and report connect time. Not ICMP, so no special privileges needed.
- Slow-response alerts — set a per-monitor latency threshold and get warned when the p95 response time crosses it, separately from up/down. Flap-damped so a brief spike doesn't page.
- More notification channels — Telegram, Discord, and PagerDuty, alongside the existing email, Slack, and generic webhooks. Each type has its own settings form (Telegram takes a separate bot token and chat ID), is testable from the alert-channels screen, and delivers on incidents and recoveries.
- Heartbeat / cron monitoring — create a heartbeat monitor and get a unique check-in URL for your scheduled job to request each run. If it goes quiet past its interval (plus a short grace), nabz opens an incident and alerts; the next check-in resolves it.
- DNS monitoring — check that a hostname resolves (A / AAAA / CNAME / MX / TXT / NS), optionally against a specific resolver and an expected value; alerts when resolution fails or returns the wrong answer, and records the resolution time.
- Recovery alerts now respect the escalation policy — a "back up" notice goes only to the channels that were actually paged for the incident, not every channel you own.

## v0.1.0

_2026-07-26_

- TCP port monitors — check whether a service is reachable on a `host:port` and how fast it connects.
- SSL/TLS certificate expiry warnings — get told before a monitored HTTPS certificate lapses.
- Response-body checks — fail a check even on a 200 when the page is missing (or unexpectedly contains) specific text.
- Per-monitor HTTP options — method (GET/HEAD/POST), custom request headers, an expected status code, a follow-redirects toggle, and a request timeout.
- Maintenance windows — schedule planned work so alerts are suppressed while checks keep running.
- Tags, search, and status/tag filtering on the monitors list.
- Rate-limited sites (HTTP 429/403) are marked "rate-limited" instead of down, and nabz now identifies itself with a proper checker User-Agent so fewer sites block it.
- Redirects are followed by default, so checks and body assertions see the final page.
- Clearer feedback when adding or editing a monitor: validation errors appear right under the field, and saves and deletes confirm with a toast.
- Fixed: a monitor could keep being checked from a region after you removed that region.
