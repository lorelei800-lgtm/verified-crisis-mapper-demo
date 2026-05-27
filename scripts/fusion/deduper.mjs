/**
 * Two-stage deduplication: H3 + temporal first, then country + hazard +
 * wider temporal window for sources at incompatible spatial resolutions.
 *
 * **Stage 1 — precise (H3 res 8 + ±30min):** the original local-event match.
 * Catches sources that publish actual event coords (GDACS, Copernicus EMS).
 *
 * **Stage 2 — country-level (ISO3 + hazard + ±7d):** ReliefWeb only carries
 * country centroids, so its events never fall in the same H3 cell as a
 * GDACS report — the same Thailand flood lives at (15.87, 100.99) on the
 * ReliefWeb side and at (13.75, 100.50) on the GDACS side, ≈235 km apart.
 * Without this stage, cross-source agreement is invisible and the dashboard
 * misses its most important signal. We require ISO3 + hazard match + ±7d
 * to be conservative.
 *
 * Single-source events still pass through this function — they become
 * FusedEvents with `isFused=false, sourceCount=1`.
 *
 * The "representative" fields (title, description, coords, severity) come
 * from the record with the highest sourceIntegrity so the dashboard always
 * shows the most authoritative summary.
 */
import { latLngToCell } from 'h3-js'

const H3_RES = 8                                // ≈ 0.74 km² hexagons
const WINDOW_MS = 30 * 60 * 1000               // ±30min (stage 1)
const COUNTRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // ±7d (stage 2)

/**
 * @param {import('../../src/types/fusion').CrisisEvent[]} events
 * @returns {import('../../src/types/fusion').FusedEvent[]}
 */
export function dedupe (events) {
  // Make sure every event has an h3Cell.
  const annotated = events.map(e => ({
    ...e,
    h3Cell: e.h3Cell ?? latLngToCell(e.lat, e.lng, H3_RES),
  }))

  // ── Stage 1: H3 res 8 + ±30min clustering ────────────────────────────
  /** @type {Map<string, typeof annotated>} */
  const byCell = new Map()
  for (const e of annotated) {
    const list = byCell.get(e.h3Cell) ?? []
    list.push(e)
    byCell.set(e.h3Cell, list)
  }

  /** @type {Array<typeof annotated>} */
  const stage1Clusters = []
  for (const cellEvents of byCell.values()) {
    cellEvents.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))

    let cluster = []
    let clusterStart = null
    const flush = () => {
      if (cluster.length === 0) return
      stage1Clusters.push(cluster)
      cluster = []
      clusterStart = null
    }
    for (const e of cellEvents) {
      const ts = Date.parse(e.occurredAt)
      if (clusterStart === null) {
        cluster = [e]; clusterStart = ts; continue
      }
      if (ts - clusterStart <= WINDOW_MS && hazardsCompatible(cluster, e)) {
        cluster.push(e)
      } else {
        flush(); cluster = [e]; clusterStart = ts
      }
    }
    flush()
  }

  // ── Stage 2: country + hazard + ±7d for any cluster that still has
  // ── room to merge with another (matches GDACS↔ReliefWeb pairs that
  // ── miss stage 1 because of country-centroid vs event-coords).
  /** @type {Array<typeof annotated>} */
  const stage2Clusters = []
  const consumed = new Set()
  for (let i = 0; i < stage1Clusters.length; i++) {
    if (consumed.has(i)) continue
    const merged = [...stage1Clusters[i]]
    const baseCountry = pickCountry(merged)
    const baseHazard  = pickHazard(merged)
    const baseStart   = Date.parse(merged[0].occurredAt)

    if (baseCountry && baseHazard) {
      const baseSources = new Set(merged.map(e => e.sourceType))
      for (let j = i + 1; j < stage1Clusters.length; j++) {
        if (consumed.has(j)) continue
        const other = stage1Clusters[j]
        const otherCountry = pickCountry(other)
        const otherHazard  = pickHazard(other)
        const otherStart   = Date.parse(other[0].occurredAt)
        const otherSources = new Set(other.map(e => e.sourceType))
        // Only merge across DIFFERENT sources at the country stage. Two
        // GDACS reports in different H3 cells but the same country+hazard
        // are almost always distinct events (multiple earthquakes in
        // Indonesia within a week is normal); a GDACS + a ReliefWeb in
        // the same country+hazard+week is almost always the same event
        // reported at two different spatial resolutions.
        const sourceOverlap = [...baseSources].some(s => otherSources.has(s))
        if (sourceOverlap) continue
        if (
          otherCountry === baseCountry &&
          otherHazard  === baseHazard  &&
          Math.abs(otherStart - baseStart) <= COUNTRY_WINDOW_MS
        ) {
          merged.push(...other)
          for (const s of otherSources) baseSources.add(s)
          consumed.add(j)
        }
      }
    }
    consumed.add(i)
    stage2Clusters.push(merged)
  }

  return stage2Clusters.map(mergeCluster)
}

function pickCountry (cluster) {
  for (const c of cluster) if (c.country) return c.country
  return null
}

function pickHazard (cluster) {
  // Use the first non-'other' hazard if any; falls back to whatever's there.
  for (const c of cluster) if (c.hazardType !== 'other') return c.hazardType
  return cluster[0]?.hazardType ?? null
}

function hazardsCompatible (cluster, candidate) {
  for (const c of cluster) {
    if (c.hazardType === candidate.hazardType) return true
    if (c.hazardType === 'other' || candidate.hazardType === 'other') return true
  }
  return false
}

/**
 * @param {import('../../src/types/fusion').CrisisEvent[]} cluster
 * @returns {import('../../src/types/fusion').FusedEvent}
 */
function mergeCluster (cluster) {
  // Choose the "most authoritative" record as the representative.
  const sorted = [...cluster].sort(
    (a, b) => b.trustScore.sourceIntegrity - a.trustScore.sourceIntegrity,
  )
  const rep = sorted[0]

  // Distinct sources contributing to this fused event.
  const distinctSources = new Set(cluster.map(c => c.sourceType))

  return {
    ...rep,
    isFused: distinctSources.size > 1,
    sourceCount: distinctSources.size,
    lineage: {
      fusedFrom: cluster.map(c => ({
        sourceType: c.sourceType,
        eventId:    c.eventId,
        url:        c.url,
        detectedAt: c.detectedAt,
      })),
    },
  }
}
