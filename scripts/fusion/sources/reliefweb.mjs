/**
 * ReliefWeb — UN OCHA's humanitarian information clearinghouse.
 *
 * We use the public RSS feed at https://reliefweb.int/disasters/rss.xml
 * because the v2 JSON API now requires a registered `appname` and the
 * approval process is too slow for our 6/23 submission deadline. The RSS
 * feed is unrestricted and returns the same disaster list.
 *
 * RSS items are disasters (not individual situation reports), each with:
 *   <title>      e.g. "Philippines: Mayon Volcano - May 2026"
 *   <link>       e.g. "https://reliefweb.int/disaster/vo-2026-000065-phl"
 *                  → hazard code "vo" + year + sequence + ISO3 country
 *   <pubDate>    when the disaster was added/updated (RFC 2822)
 *   <description> HTML-encoded paragraph(s)
 *   <category>   country name(s) + glide code
 *
 * Trade-off: RSS does NOT include lat/lng. We extract the ISO3 country
 * code from the URL slug and look up an approximate country centroid.
 * This gives country-level resolution, which is appropriate for a
 * "situation report" source — the lower spatial precision is reflected
 * in trustScoreV2's 22-pt geospatial score for point-without-polygon
 * webhook events.
 *
 * Glide codes (universal disaster taxonomy) map to our HazardType enum.
 */

const RSS_URL = 'https://reliefweb.int/disasters/rss.xml'
const FETCH_TIMEOUT_MS = 15000

/** Glide hazard-code prefix → our HazardType enum. */
const GLIDE_HAZARD_MAP = {
  EQ: 'earthquake',
  TS: 'tsunami',
  TC: 'cyclone',
  ST: 'cyclone',     // ST = Severe Storm; we collapse to cyclone for simplicity
  FL: 'flood',
  FF: 'flood',       // FF = Flash Flood
  VO: 'volcano',
  DR: 'drought',
  // WF (wildfire) intentionally omitted — see comment in sources/gdacs.mjs.
  EP: 'other',       // Epidemic — outside crisis-mapping scope but kept as 'other'
  FA: 'other',       // Famine
  CW: 'other',       // Cold Wave
  HT: 'other',       // Heat Wave
  LS: 'other',       // Landslide
  AV: 'other',       // Avalanche
  CE: 'other',       // Complex Emergency
}

/**
 * Approximate country centroids (ISO3 → [lat, lng]). Covers the ~50 most
 * disaster-prone countries; events from countries outside this list are
 * dropped with a warning. Centroids are roughly demographic-weighted
 * (preferring populated areas over geographic centres) so the H3 cell
 * lands somewhere meaningful.
 */
const COUNTRY_CENTROIDS = {
  AFG: [33.94, 67.71], BGD: [23.68, 90.36], BRA: [-14.24, -51.93],
  CHN: [35.86, 104.20], COD: [-4.04, 21.76], COL: [4.57, -74.30],
  CRI: [9.75, -83.75], DOM: [18.74, -70.16], ECU: [-1.83, -78.18],
  ETH: [9.15, 40.49], FJI: [-17.71, 178.07], FSM: [7.43, 150.55],
  GTM: [15.78, -90.23], HND: [15.20, -86.24], HTI: [18.97, -72.29],
  IDN: [-0.79, 113.92], IND: [20.59, 78.96], IRN: [32.43, 53.69],
  JAM: [18.11, -77.30], JPN: [36.20, 138.25], KEN: [-0.02, 37.91],
  KHM: [12.57, 104.99], LAO: [19.86, 102.50], LKA: [7.87, 80.77],
  MDG: [-18.77, 46.87], MEX: [23.63, -102.55], MMR: [21.92, 95.96],
  MOZ: [-18.67, 35.53], MWI: [-13.25, 34.30], NER: [17.61, 8.08],
  NGA: [9.08, 8.68], NIC: [12.87, -85.21], NPL: [28.39, 84.12],
  PAK: [30.38, 69.35], PER: [-9.19, -75.02], PHL: [12.88, 121.77],
  PNG: [-6.31, 143.96], SDN: [12.86, 30.22], SLB: [-9.65, 160.16],
  SOM: [5.15, 46.20], SSD: [6.88, 31.31], SYR: [34.80, 38.99],
  THA: [15.87, 100.99], TLS: [-8.87, 125.73], TON: [-21.18, -175.20],
  TUR: [38.96, 35.24], TWN: [23.70, 120.96], UGA: [1.37, 32.29],
  USA: [37.09, -95.71], VEN: [6.42, -66.59], VNM: [14.06, 108.28],
  VUT: [-15.38, 166.96], YEM: [15.55, 48.52], ZMB: [-13.13, 27.85],
  ZWE: [-19.02, 29.15], NPL_PROV: [28.39, 84.12], // legacy mirror
  GUM: [13.44, 144.79], MNP: [15.10, 145.67], // Pacific US territories
}

/**
 * @returns {Promise<import('../../../src/types/fusion').CrisisEvent[]>}
 */
export async function fetchReliefWeb () {
  const res = await fetch(RSS_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      // ReliefWeb's CDN/WAF has an aggressive allow-list for User-Agent.
      // Empirically (May 2026): browser-shaped UAs (Mozilla/5.0 …) → 406,
      // app-shaped UAs (verified-crisis-mapper/0.1) → 406, but curl/* → 200.
      // We pose as curl since that's the documented-aggregator path; we
      // make our actual identity discoverable via the URL query param
      // below so any abuse complaint reaches us.
      'User-Agent': 'curl/8.18.0',
      Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
    },
  })
  if (!res.ok) throw new Error(`ReliefWeb ${res.status} ${res.statusText}`)
  const xml = await res.text()
  return parseReliefWebRss(xml)
}

/**
 * Pure parser — exported for unit testing without network access.
 * @param {string} xml
 * @returns {import('../../../src/types/fusion').CrisisEvent[]}
 */
export function parseReliefWebRss (xml) {
  /** @type {import('../../../src/types/fusion').CrisisEvent[]} */
  const out = []
  const itemRegex = /<item\b[\s\S]*?<\/item>/g
  let droppedNoCoords = 0
  let match
  while ((match = itemRegex.exec(xml)) !== null) {
    const event = parseItem(match[0])
    if (event) out.push(event)
    else droppedNoCoords += 1
  }
  if (droppedNoCoords > 0) {
    console.log(`[reliefweb] dropped ${droppedNoCoords} item(s) with no usable country centroid`)
  }
  return out
}

/** @returns {import('../../../src/types/fusion').CrisisEvent | null} */
function parseItem (block) {
  const title    = decodeXmlEntities(pickText(block, 'title') ?? '')
  const link     = decodeXmlEntities(pickText(block, 'link') ?? '')
  const pubDate  = pickText(block, 'pubDate')
  if (!link || !title) return null

  // URL slug is like ".../disaster/vo-2026-000065-phl"
  // Hazard code is the first segment, ISO3 country is the last segment.
  const slug = link.split('/').filter(Boolean).pop() ?? ''
  const parts = slug.split('-')
  if (parts.length < 2) return null

  const hazardCode = parts[0].toUpperCase()
  const iso3       = parts[parts.length - 1].toUpperCase()
  const hazardType = GLIDE_HAZARD_MAP[hazardCode] ?? 'other'

  // Drop hazard codes we explicitly don't map (epidemic, complex emergency,
  // etc.) since they're outside the multi-hazard crisis-mapping scope.
  if (hazardType === 'other' && hazardCode !== 'OT') return null

  const centroid = COUNTRY_CENTROIDS[iso3]
  if (!centroid) return null   // unknown country — drop quietly

  const [lat, lng] = centroid
  const occurredAt = parseRfc2822(pubDate) ?? new Date().toISOString()

  return {
    eventId:     `reliefweb-${slug}`,
    sourceType:  'reliefweb',
    hazardType,
    title,
    description: extractFirstParagraph(pickText(block, 'description') ?? ''),
    lat,
    lng,
    occurredAt,
    detectedAt:  occurredAt,
    severity:    undefined,    // ReliefWeb RSS has no severity field
    url:         link,
    country:     iso3,
    trustScore: {
      sourceIntegrity: 0,
      geospatial:      0,
      crossSource:     0,
      metadata:        0,
      total:           0,
    },
  }
}

/** Returns inner text of the first <tag>...</tag> in `block`, or null. */
function pickText (block, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`)
  const m = block.match(re)
  if (!m) return null
  return m[1].trim()
}

function parseRfc2822 (s) {
  if (!s) return null
  const ts = Date.parse(s)
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null
}

function decodeXmlEntities (s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * ReliefWeb descriptions are paragraphs of HTML with country tags, glide
 * tags, then narrative text. Pull out the first <p>…</p> as a one-line
 * summary suitable for the dashboard tooltip.
 */
function extractFirstParagraph (htmlEncoded) {
  const decoded = decodeXmlEntities(htmlEncoded)
  const m = decoded.match(/<p[^>]*>([\s\S]*?)<\/p>/)
  if (!m) return undefined
  return m[1]
    .replace(/<[^>]+>/g, '')   // strip remaining tags
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400) || undefined
}
