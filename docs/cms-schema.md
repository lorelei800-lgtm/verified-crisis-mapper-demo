# Re:Earth CMS schema reference

The Verified Crisis Mapper React app reads from and writes to two Re:Earth CMS
models: **`damage-report`** (citizen-submitted reports) and
**`deployment-config`** (per-deployment runtime settings). This document is
the authoritative list of field keys and types so the schema in CMS stays in
sync with what the code expects.

If a field listed here is missing from the live CMS model, the corresponding
write is silently dropped by Re:Earth CMS — the app will fall back to local
defaults but the data won't survive a reload. Adding the field via the
Re:Earth CMS web UI is a one-time setup.

---

## Model: `damage-report`

A single citizen-submitted damage report. Mirrors the `DamageReport` type in
`src/types/index.ts`.

| Field key            | Type         | Required | Source                                         | Notes |
|----------------------|--------------|----------|------------------------------------------------|-------|
| `timestamp`          | Text         | yes      | Reporter form + bootstrap script               | ISO 8601 string (e.g. `2026-10-14T06:00:00.000Z`). The dashboard "Time" column reads this; if the field is missing, falls back to a hash of the item id. |
| `damage_level`       | Text         | yes      | Reporter form (radio)                          | One of `minimal` / `partial` / `destroyed`. |
| `infra_type`         | Text         | yes      | Reporter form (radio)                          | One of `residential` / `commercial` / `government` / `utility` / `transport` / `community` / `public_space` / `other`. |
| `landmark`           | Text         | yes      | Reporter form                                  | Free-form, optionally auto-filled via Nominatim. |
| `district`           | Text         | no       | Reporter form / Nominatim                      | District / sub-locality. |
| `lat`                | Number       | yes      | GPS / map picker                               | WGS84 latitude. |
| `lng`                | Number       | yes      | GPS / map picker                               | WGS84 longitude. |
| `channel`            | Text         | yes      | Set by app                                     | `pwa` / `browser` / `whatsapp`. |
| `has_c2pa`           | Checkbox     | no       | Photo metadata                                 | Defaults to `false`. |
| `h3_cell`            | Text         | yes      | Computed                                       | H3 res-9 cell index. |
| `image`              | Asset        | no       | Photo upload                                   | Uploaded via the Asset API; the dashboard renders `image.url`. |
| `tier`               | Text         | yes      | Computed from `trust_score_total`              | `green` (≥80), `amber` (50–79), or `red` (<50). |
| `trust_score_total`  | Number       | yes      | Computed                                       | 0–100. |
| `trust_score_image`  | Number       | yes      | Computed                                       | 0–40. |
| `trust_score_geo`    | Number       | yes      | Computed                                       | 0–30. |
| `trust_score_cross`  | Number       | yes      | Computed                                       | 0–20. |
| `trust_score_meta`   | Number       | yes      | Computed                                       | 0–10. |
| `review_status`      | Text         | no       | Admin Review Panel                             | `approved` / `rejected` / `""` (pending). |
| `reject_reason`      | Text         | no       | Admin Review Panel                             | Set when `review_status === 'rejected'`. |

---

## Model: `deployment-config`

Runtime settings that let one CMS workspace serve multiple disaster
scenarios. The dashboard reads exactly one row per deployment (the first
row returned by the public read API) and uses its values to centre the map,
draw the area boundary, and label the header.

| Field key                | Type   | Notes |
|--------------------------|--------|-------|
| `title`                  | Text   | Big header text, e.g. "Bangkok Flood Response". |
| `scenario_label`         | Text   | Full event description, e.g. "Bangkok Flood, Chao Phraya Basin, October 2026". |
| `subtitle`               | Text   | Area subtitle, e.g. "Don Mueang / Bang Sue". |
| `bounds_sw_lat`          | Number | Map fit-bounds SW corner. |
| `bounds_sw_lng`          | Number | |
| `bounds_ne_lat`          | Number | Map fit-bounds NE corner. |
| `bounds_ne_lng`          | Number | |
| `area_center_lat`        | Number | Centre of the "allowed reporting area" circle. |
| `area_center_lng`        | Number | |
| `area_radius_km`         | Number | Radius in km — reports outside this get a low geospatial Trust Score. |
| `admin_pin`              | Text   | 6-digit PIN gating the Admin Review Panel. |
| `viewer_pin`             | Text   | Optional 6-digit PIN gating the Dashboard. Empty = public. |
| `label_damage_minimal`   | Text   | Localised label override (e.g. "Minimal"). |
| `label_damage_partial`   | Text   | Localised label override (e.g. "Partially Damaged"). |
| `label_damage_destroyed` | Text   | Localised label override (e.g. "Completely Destroyed"). |
| `description`            | Text   | One-line description displayed in the header. |

> **Note:** Rows in this model are usually created via the Re:Earth CMS web
> UI. Once created that way, the Integration API used by
> `scripts/bootstrap-bangkok.mjs` cannot PATCH them ("operation denied") —
> edit them in the web UI instead. The bootstrap script detects this case
> and exits cleanly rather than failing.

---

## Model: `verified-events`

Webhook-sourced events produced by the fusion pipeline
(`scripts/fusion/run.mjs`). Read-only from the dashboard; written by the
hourly GitHub Actions cron.

| Field key             | Type   | Notes |
|-----------------------|--------|-------|
| `event_id`            | Text   | Stable id within the source, e.g. `gdacs-EQ-1462184`. |
| `source_type`         | Text   | `citizen` / `gdacs` / `copernicus` / `reliefweb`. |
| `hazard_type`         | Text   | `earthquake` / `tsunami` / `cyclone` / `flood` / `volcano` / `drought` / `wildfire` / `other`. |
| `title`               | Text   | Short human-readable summary. |
| `description`         | Text   | Optional longer detail. |
| `lat`, `lng`          | Number | Event coordinates. |
| `h3_cell`             | Text   | H3 res-8 cell (≈ 0.74 km²) — used for dedupe. |
| `occurred_at`         | Text   | ISO 8601, event occurrence time. |
| `detected_at`         | Text   | ISO 8601, when source published. |
| `severity`            | Text   | `red` / `orange` / `green` (GDACS-style). |
| `source_url`          | Text   | Canonical link back to the source record. |
| `trust_total`         | Number | 0–100. |
| `trust_source`        | Number | 0–40. |
| `trust_geo`           | Number | 0–30. |
| `trust_cross`         | Number | 0–20. |
| `trust_meta`          | Number | 0–10. |
| `source_count`        | Number | 1 for unfused, 2+ for cross-validated. |
| `is_fused`            | Checkbox | True iff aggregated from 2+ sources. |
| `lineage_json`        | Text   | JSON-encoded `Lineage` object with the merged source ids. |
| `affected_area_json`  | Text   | JSON-encoded GeoJSON polygon, optional. |

---

## How to add a missing field in Re:Earth CMS

1. Log into Re:Earth CMS and open the workspace.
2. Click into the model (`damage-report`, `deployment-config`, or
   `verified-events`).
3. Open the **Schema** tab → **Add field**.
4. Set the **Key** exactly as listed above (case-sensitive, snake_case).
5. Pick the matching **Type** from the table.
6. Save the schema. New writes to that key will now be persisted.

After adding a field, you may want to backfill existing rows. The simplest
path is to re-run the bootstrap workflow:

> GitHub Actions → **Bootstrap CMS to Bangkok** → **Run workflow** → mode
> `replace`.

This wipes the existing damage-report rows and re-seeds the 28 mockReports
with all listed fields populated.
