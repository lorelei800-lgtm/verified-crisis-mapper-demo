# Verified Crisis Mapper — Public Demo

Open-source demonstration build of **Verified Crisis Mapper**, a citizen-report
crisis-mapping prototype built on [Re:Earth](https://reearth.io) by
[Eukarya Inc.](https://eukarya.io)

**Live demo:** https://lorelei800-lgtm.github.io/verified-crisis-mapper-demo/

This repository contains **only the open-source demo application** — the React
+ Vite + MapLibre front end and the multi-source fusion scripts. It contains no
confidential material and no credentials.

## What it shows

- **Citizen reporting PWA** — submit geotagged damage reports from a phone
- **Trust Score engine** — every report scored on image integrity, geospatial
  consistency, cross-report corroboration, and metadata
- **Multi-source fusion** — public hazard feeds (GDACS, Copernicus EMS,
  ReliefWeb) ingested and cross-validated against citizen reports
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
demo is **read-only**; it never holds a CMS write token.

## Security note

This is a public repository, so the GitHub Pages build injects only
**non-secret** connection variables. A CMS write token must never be added to
the client build — Vite bakes `VITE_*` vars into the publicly served bundle.

## License

[Apache-2.0](./LICENSE) © 2026 Eukarya Inc.
