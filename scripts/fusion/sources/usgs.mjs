/**
 * USGS Earthquake Hazards Program — the US Geological Survey's real-time
 * earthquake feed. Authoritative seismographic source, unauthenticated,
 * stable public GeoJSON.
 *
 * Endpoint: the "significant earthquakes, past 30 days" summary feed. This is
 * a curated set (a handful to a few dozen per month), which keeps the map
 * uncluttered while still overlapping the larger earthquakes GDACS also
 * reports — so the same physical quake appears in BOTH feeds and the fusion
 * pipeline can cross-validate it (GDACS + USGS → green tier). The deduper's
 * distance-based stage merges the two epicenter solutions (which differ by a
 * few km between agencies) into one verified event.
 *
 * GeoJSON shape (per feature):
 *   id
 *   properties.mag        magnitude (number)
 *   properties.place      e.g. "98 km SSE of Whatever, Country"
 *   properties.time       origin time (epoch ms)
 *   properties.url        canonical event page
 *   properties.title      e.g. "M 6.1 - 98 km SSE of ..."
 *   geometry.coordinates  [lng, lat, depth_km]
 */

const USGS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson'
const FETCH_TIMEOUT_MS = 15000

/**
 * @returns {Promise<import('../../../src/types/fusion').CrisisEvent[]>}
 */
export async function fetchUsgs () {
  const res = await fetch(USGS_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'verified-crisis-mapper/0.1 (+https://github.com/eukarya-biz/verified-crisis-mapper-demo)' },
  })
  if (!res.ok) throw new Error(`USGS ${res.status} ${res.statusText}`)
  const json = await res.json()
  return parseUsgs(json)
}

/**
 * Pure parser — exported for unit testing without network access.
 * @param {any} json  USGS GeoJSON FeatureCollection
 * @returns {import('../../../src/types/fusion').CrisisEvent[]}
 */
export function parseUsgs (json) {
  /** @type {import('../../../src/types/fusion').CrisisEvent[]} */
  const out = []
  const features = Array.isArray(json?.features) ? json.features : []
  for (const f of features) {
    const event = parseFeature(f)
    if (event) out.push(event)
  }
  return out
}

/** @returns {import('../../../src/types/fusion').CrisisEvent | null} */
function parseFeature (f) {
  const id     = f?.id
  const coords = f?.geometry?.coordinates
  const props  = f?.properties ?? {}
  if (!id || !Array.isArray(coords) || coords.length < 2) return null

  const lng = Number(coords[0])
  const lat = Number(coords[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null

  const mag = Number(props.mag)
  const occurredAt = Number.isFinite(props.time)
    ? new Date(props.time).toISOString()
    : new Date().toISOString()

  return {
    eventId:     `usgs-${id}`,
    sourceType:  'usgs',
    hazardType:  'earthquake',
    title:       props.title || `Earthquake${Number.isFinite(mag) ? ` M${mag}` : ''}`,
    description: props.place || undefined,
    lat,
    lng,
    occurredAt,
    detectedAt:  occurredAt,   // USGS publishes within seconds of origin time
    severity:    magnitudeToSeverity(mag),
    url:         props.url || undefined,
    // USGS does not provide an ISO3 country; cross-source fusion with GDACS
    // happens via the deduper's distance-based stage, not the country key.
    country:     undefined,
    trustScore: {
      sourceIntegrity: 0,
      geospatial:      0,
      crossSource:     0,
      metadata:        0,
      total:           0,
    },
  }
}

/** Map earthquake magnitude to our Red/Orange/Green severity bands. */
function magnitudeToSeverity (mag) {
  if (!Number.isFinite(mag)) return undefined
  if (mag >= 7.0) return 'red'
  if (mag >= 6.0) return 'orange'
  return 'green'
}
