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
const NEAR_KM = 150                            // distance threshold (stage 1.5)
const NEAR_WINDOW_MS = 60 * 60 * 1000          // ±60min (stage 1.5)
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

  // ── Stage 1.5: distance-based merge for precise-coordinate sources that
  // ── report the SAME physical event at slightly different epicenters.
  // ── e.g. GDACS and USGS both publish a large earthquake, but their epicenter
  // ── solutions differ by a few km, so they land in different H3 res-8 cells
  // ── and stage 1 misses them. Merge clusters within NEAR_KM + ±60min +
  // ── compatible hazard, but ONLY across different sources (two GDACS quakes
  // ── 100 km apart are distinct events; a GDACS + a USGS quake 20 km / 5 min
  // ── apart is the same event seen by two agencies).
  const stage15Clusters = mergeNearbyAcrossSources(stage1Clusters)

  // ── Stage 2: country + hazard + ±7d for any cluster that still has
  // ── room to merge with another (matches GDACS↔ReliefWeb pairs that
  // ── miss stage 1 because of country-centroid vs event-coords).
  /** @type {Array<typeof annotated>} */
  const stage2Clusters = []
  const consumed = new Set()
  for (let i = 0; i < stage15Clusters.length; i++) {
    if (consumed.has(i)) continue
    const merged = [...stage15Clusters[i]]
    const baseCountry = pickCountry(merged)
    const baseHazard  = pickHazard(merged)
    const baseStart   = Date.parse(merged[0].occurredAt)

    if (baseCountry && baseHazard) {
      const baseSources = new Set(merged.map(e => e.sourceType))
      for (let j = i + 1; j < stage15Clusters.length; j++) {
        if (consumed.has(j)) continue
        const other = stage15Clusters[j]
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

/**
 * Stage 1.5 — merge stage-1 clusters that describe the same physical event but
 * landed in different H3 cells (different agencies' epicenter solutions).
 * Merge criteria: within NEAR_KM, within ±NEAR_WINDOW_MS, compatible hazard,
 * and crucially across DIFFERENT sources only.
 * @param {Array<any[]>} clusters
 * @returns {Array<any[]>}
 */
function mergeNearbyAcrossSources (clusters) {
  const out = []
  const consumed = new Set()
  for (let i = 0; i < clusters.length; i++) {
    if (consumed.has(i)) continue
    const merged = [...clusters[i]]
    let sources = new Set(merged.map(e => e.sourceType))
    const repA = merged[0]
    const hazA = pickHazard(merged)
    const startA = Date.parse(merged[0].occurredAt)
    for (let j = i + 1; j < clusters.length; j++) {
      if (consumed.has(j)) continue
      const other = clusters[j]
      const otherSources = new Set(other.map(e => e.sourceType))
      // Different sources only — never merge two records from the same source.
      if ([...sources].some(s => otherSources.has(s))) continue
      const hazB = pickHazard(other)
      const hazOk = hazA === hazB || hazA === 'other' || hazB === 'other'
      if (!hazOk) continue
      const repB = other[0]
      const startB = Date.parse(other[0].occurredAt)
      if (
        haversineKm(repA.lat, repA.lng, repB.lat, repB.lng) <= NEAR_KM &&
        Math.abs(startB - startA) <= NEAR_WINDOW_MS
      ) {
        merged.push(...other)
        for (const s of otherSources) sources.add(s)
        consumed.add(j)
      }
    }
    consumed.add(i)
    out.push(merged)
  }
  return out
}

/** Great-circle distance between two lat/lng points, in kilometres. */
function haversineKm (lat1, lng1, lat2, lng2) {
  const R = 6371
  const toRad = d => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
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
