/**
 * Trust Score v2 — applies the existing 40/30/20/10 weighting (same as
 * citizen reports in `src/utils/trustScore.ts`) but reinterprets each factor
 * for webhook-sourced events.
 *
 * | Factor                          | Weight | Webhook interpretation                                            |
 * | ------------------------------- | ------ | ----------------------------------------------------------------- |
 * | Source / Content Integrity      | 0–40   | HTTPS signature + publisher prior (per source)                    |
 * | Geospatial Consistency          | 0–30   | Polygon coverage / coordinate plausibility                        |
 * | Cross-Source Validation         | 0–20   | Distinct sources confirming the same H3 cell within ±30min        |
 * | Source Reliability × Metadata   | 0–10   | Publisher reliability prior + completeness of optional metadata   |
 *
 * Thresholds remain ≥80 green / ≥50 amber / <50 red.
 *
 * Note: the source modules pre-fill `sourceIntegrity` and `metadata` because
 * those depend on source-specific signals. `scoreAll` only refines the
 * `geospatial` and `crossSource` factors (which depend on the fused result),
 * then totals everything.
 */

const SOURCE_INTEGRITY_PRIOR = {
  gdacs:      38,   // UN-affiliated, multi-hazard, signed RSS
  copernicus: 38,   // European Commission, satellite-derived
  reliefweb:  35,   // OCHA-curated, but human-edited
  citizen:    20,   // dynamic; further adjusted per-report
}

const SOURCE_METADATA_PRIOR = {
  gdacs:      9,
  copernicus: 9,
  reliefweb:  8,
  citizen:    5,    // dynamic; further adjusted per-report
}

/**
 * @param {import('../../src/types/fusion').FusedEvent[]} events
 * @returns {import('../../src/types/fusion').FusedEvent[]}
 */
export function scoreAll (events) {
  return events.map(score)
}

function score (event) {
  // Source integrity comes from the prior table unless the source module
  // already filled something in (e.g. citizen reports with C2PA bonus).
  const sourceIntegrity = clamp(
    event.trustScore.sourceIntegrity || SOURCE_INTEGRITY_PRIOR[event.sourceType] || 20,
    0,
    40,
  )

  // Geospatial: webhook sources are scored on whether they carry coordinates
  // AND optionally an affected-area polygon. Citizens use the existing GPS
  // bands (already scored upstream).
  let geospatial
  if (event.sourceType === 'citizen') {
    geospatial = clamp(event.trustScore.geospatial, 0, 30)
  } else {
    if (event.affectedArea) {
      geospatial = 30   // polygon + point — strongest geospatial confidence
    } else if (Number.isFinite(event.lat) && Number.isFinite(event.lng)) {
      geospatial = 22   // point only
    } else {
      geospatial = 8    // weak — country-level only
    }
  }

  // Cross-source: +20 if 3+ distinct sources, +12 if 2, +0 if 1.
  let crossSource
  if (event.sourceCount >= 3)      crossSource = 20
  else if (event.sourceCount === 2) crossSource = 12
  else                              crossSource = 0

  const metadata = clamp(
    event.trustScore.metadata || SOURCE_METADATA_PRIOR[event.sourceType] || 5,
    0,
    10,
  )

  const total = clamp(sourceIntegrity + geospatial + crossSource + metadata, 0, 100)

  return {
    ...event,
    trustScore: { sourceIntegrity, geospatial, crossSource, metadata, total },
  }
}

function clamp (n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}
