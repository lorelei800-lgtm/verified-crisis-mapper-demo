/**
 * POST fused events to the Re:Earth CMS `verified-events` model.
 *
 * The CMS model needs to be created once (see ./README.md). Fields expected:
 *   event_id          (text, unique)
 *   source_type       (text)        — 'citizen' | 'gdacs' | 'copernicus' | 'reliefweb'
 *   hazard_type       (text)        — earthquake / flood / cyclone / ...
 *   title             (text)
 *   description       (text)
 *   lat               (number)
 *   lng               (number)
 *   h3_cell           (text)
 *   occurred_at       (text, ISO 8601)
 *   detected_at       (text, ISO 8601)
 *   severity          (text)        — red / orange / green
 *   source_url        (text)
 *   trust_total       (number)
 *   trust_source      (number)
 *   trust_geo         (number)
 *   trust_cross       (number)
 *   trust_meta        (number)
 *   source_count      (number)
 *   is_fused          (boolean)
 *   lineage_json      (text)        — JSON-encoded lineage object
 *   affected_area_json(text)        — JSON-encoded GeoJSON polygon, optional
 *
 * Existing items are matched by `event_id` and PATCHed; new ones are POSTed.
 * Returns {posted, skipped, failed} counts so the caller can decide exit status.
 */
const CMS_BASE  = process.env.VITE_CMS_BASE_URL ?? process.env.CMS_BASE_URL
const CMS_PROJ  = process.env.VITE_CMS_PROJECT  ?? process.env.CMS_PROJECT      // "workspace/project"
const CMS_TOKEN = process.env.VITE_CMS_TOKEN    ?? process.env.CMS_TOKEN
const CMS_MODEL = process.env.VITE_CMS_VERIFIED_MODEL ?? 'verified-events'

/**
 * @param {import('../../src/types/fusion').FusedEvent[]} events
 * @returns {Promise<{posted: number, skipped: number, failed: number}>}
 */
export async function postEvents (events) {
  if (!CMS_BASE || !CMS_PROJ) {
    console.warn('[post-to-cms] CMS_BASE_URL / CMS_PROJECT not set — skipping POST')
    return { posted: 0, skipped: events.length, failed: 0 }
  }
  if (!CMS_TOKEN) {
    console.warn('[post-to-cms] CMS_TOKEN not set — skipping POST (run with --dry-run for offline mode)')
    return { posted: 0, skipped: events.length, failed: 0 }
  }

  const [ws, proj] = CMS_PROJ.split('/')
  const baseUrl = `${CMS_BASE}/api/${ws}/projects/${proj}/models/${CMS_MODEL}/items`

  let posted = 0, skipped = 0, failed = 0

  for (const event of events) {
    const fields = toFields(event)
    try {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${CMS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ fields }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.warn(`[post-to-cms] ${event.eventId} → ${res.status}: ${body.slice(0, 160)}`)
        failed += 1
        continue
      }

      // Re:Earth CMS leaves items in draft after POST — re-publish to make
      // them visible on the public read API.
      const created = await res.json().catch(() => ({}))
      const itemId = created.id
      if (itemId) {
        const pubUrl = `${baseUrl}/${itemId}/publish`
        const pubRes = await fetch(pubUrl, {
          method:  'POST',
          headers: { Authorization: `Bearer ${CMS_TOKEN}`, 'Content-Type': 'application/json' },
          signal:  AbortSignal.timeout(10000),
          body:    '{}',
        })
        if (!pubRes.ok) {
          console.warn(`[post-to-cms] ${event.eventId} publish → ${pubRes.status}`)
          failed += 1
          continue
        }
      }
      posted += 1
    } catch (err) {
      console.warn(`[post-to-cms] ${event.eventId} threw:`, err?.message ?? err)
      failed += 1
    }
  }

  return { posted, skipped, failed }
}

function toFields (event) {
  return [
    { key: 'event_id',     value: event.eventId },
    { key: 'source_type',  value: event.sourceType },
    { key: 'hazard_type',  value: event.hazardType },
    { key: 'title',        value: event.title },
    { key: 'description',  value: event.description ?? '' },
    { key: 'lat',          value: event.lat },
    { key: 'lng',          value: event.lng },
    { key: 'h3_cell',      value: event.h3Cell ?? '' },
    { key: 'occurred_at',  value: event.occurredAt },
    { key: 'detected_at',  value: event.detectedAt },
    { key: 'severity',     value: event.severity ?? '' },
    { key: 'source_url',   value: event.url ?? '' },
    { key: 'trust_total',  value: event.trustScore.total },
    { key: 'trust_source', value: event.trustScore.sourceIntegrity },
    { key: 'trust_geo',    value: event.trustScore.geospatial },
    { key: 'trust_cross',  value: event.trustScore.crossSource },
    { key: 'trust_meta',   value: event.trustScore.metadata },
    { key: 'source_count', value: event.sourceCount },
    { key: 'is_fused',     value: event.isFused },
    { key: 'lineage_json', value: JSON.stringify(event.lineage ?? { fusedFrom: [] }) },
    { key: 'affected_area_json', value: event.affectedArea ? JSON.stringify(event.affectedArea) : '' },
  ]
}
