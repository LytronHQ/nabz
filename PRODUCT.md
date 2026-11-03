# Product

<!-- impeccable:product-schema 1 -->

> Written on 2026-11-01 from the repository and confirmed by the owner the same day.

## Platform

web

## Users

Developers and sysadmins who run services on the internet and need to know when one
stops answering, without being woken by false alarms.

Their job: add the URLs, ports, DNS names or heartbeat check-ins they care about,
choose who gets told and how, then forget about it until something really breaks.

A second audience is self-hosters running the open-source code on their own fleet.

## Product Purpose

nabz watches services from several zones and reports a service as down only when the
zones agree, then opens an incident and alerts through the channels the user chose.
Success is: every real outage reaches the right person quickly, and a single zone's
network blip never does.

## Positioning

Cross-zone consensus before any alert: a check failing from one zone is not an
outage until other zones confirm it, and a failure caused by nabz's own network is not
counted against the user's uptime.

## Operating Context

- Users manage monitors, alert channels, escalation policies and dependencies in the
  web app, and receive alerts by email, webhook, Slack, Discord, Telegram, PagerDuty and
  browser push.
- Alerts arrive at any hour; the product exists to keep night-time pages to real
  outages.
- Anonymous visitors can try one website monitor without an account before signing up.

## Capabilities and Constraints

- Monitor types in the code: website (HTTP, with keyword checks), ping, port, DNS,
  heartbeat check-ins, Duplicati backups.
- Zones in production: eu-central and ap-southeast.
- Sign-in with email/password, GitHub and Google.
- Public status pages at `nabz.sh/s/<slug>` (#679): the state, 30-day uptime and
  incident times of the monitors the owner chooses, never their addresses.
- Free check tools at `nabz.sh/tools` (#684): website, SSL, port, DNS and ping,
  run from the visitor's browser on Globalping's probes (their own quota, no nabz
  outbound), each ending in a link to watch the same target with a monitor.
- Not built yet, and listed as such on the landing page: a public API with tokens,
  mail server checks.
- Plans: Free and Pro, with every limit and price in `app/src/lib/plans.ts` (#678,
  #682). Pro is $9 a month or $90 a year, tax included, shown on /pricing. Billing is
  not built yet (#681), so Pro is not on sale and nothing is charged.

## Brand Commitments

- Name: **nabz** (lowercase). Tagline: "The pulse of your infrastructure."
- Voice: plain and honest, saying what is not built yet instead of implying it
  ("Not built yet — listed honestly so you know where it's headed").
- An existing visual system is documented in docs/design-system.md; this file does not
  restate it.

## Evidence on Hand

- No customer testimonials, logos, case studies, usage numbers or press exist in the
  repository. Future work must not invent any.
- The product is live at nabz.sh with very few users so far; do not claim adoption.

## Product Principles

1. A page means a real outage: confirm before alerting, and never blame the user's
   service for nabz's own failures.
2. Set up once, then stay out of the way.
3. Say what exists and what does not; no implied features.
4. Alerts reach people where they already are, through the channel they chose.

## Accessibility & Inclusion

docs/design-system.md requires WCAG AA text contrast in both themes. No other
product-specific requirement was found.
