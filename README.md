# Verified Crisis Mapper — Public Demo

Open-source demonstration build of Verified Crisis Mapper, a citizen-report
crisis-mapping prototype built on [Re:Earth](https://reearth.io) by
[Eukarya Inc.](https://eukarya.io)

This repository contains only the open-source demo application — the React +
Vite + MapLibre front end and the multi-source fusion scripts. It contains no
confidential material and no credentials.

## What it shows

- **Citizen reporting PWA** — submit geotagged damage reports from a phone
- **Trust Score engine** — every report scored on image integrity, geospatial
  consistency, cross-report corroboration, and metadata
- **Multi-source fusion** — public hazard feeds (GDACS, USGS, ReliefWeb) ingested
  and cross-validated against citizen reports
- **Verification dashboard** — map view with source filtering and lineage

Scenario: Bangkok Flood Response — Don Mueang / Bang Sue (Chao Phraya Basin).

## Run locally

```bash
npm ci
npm run dev
```

The app runs against bundled mock data out of the box. To read live data from a
public Re:Earth CMS project, copy `.env.example` to `.env` and fill in the
read-only connection vars (base URL, project alias, model alias). The published
demo is read-only; it never holds a CMS write token.

## Deploy (manual — no GitHub Actions)

This repository is deployed **manually** from a developer machine, not by a CI
pipeline. (GitHub Actions is disabled in the `eukarya-biz` organization, so all
deployment is run locally.)

```bash
npm run deploy
```

`npm run deploy` builds the app and publishes the `dist/` output to the
`gh-pages` branch via the `gh-pages` npm package. GitHub Pages then serves that
branch.

One-time GitHub Pages setup (after the first `npm run deploy` creates the
`gh-pages` branch): repo **Settings → Pages → Build and deployment → Source →
"Deploy from a branch" → `gh-pages` / `(root)`**.

### Refreshing the webhook data

The dashboard reads `public/verified-events.json`, a committed snapshot of the
fused GDACS / USGS / ReliefWeb events. Because there is no scheduled cron, the
snapshot is refreshed **on demand**:

```bash
npm run fusion:static     # re-fetch the public feeds and rewrite the snapshot
git add public/verified-events.json && git commit -m "chore: refresh verified-events.json"
npm run deploy
```

Or run `npm run deploy:fresh` to refresh the snapshot and deploy in one step.

## Security note

This is a public repository. The build injects only non-secret read-only
connection variables. A CMS write token must never be added to the client build —
Vite bakes `VITE_*` vars into the publicly served bundle. CMS writes are handled
separately, server-side, in a private repository.

## License

[Apache-2.0](./LICENSE) © 2026 Eukarya Inc.
