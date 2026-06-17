/**
 * GDACS — Global Disaster Alert and Coordination System.
 *
 * Endpoint: https://www.gdacs.org/xml/rss.xml
 * Covers:   earthquakes, tsunamis, tropical cyclones, floods, volcanoes,
 *           droughts, wildfires. UN-affiliated (UN OCHA + EU JRC).
 *
 * GDACS RSS is well-structured XML with a fixed set of namespaces. Rather
 * than pull in a full XML parser, we extract the small handful of fields
 * we need per <item> with anchored regexes — robust against the formatting
 * variations we've observed in production samples (May 2026 snapshots).
 *
 * Each <item> typically contains:
 *   <title>                      one-line summary
 *   <description>                paragraph summary
 *   <link>                       canonical URL on gdacs.org
 *   <pubDate>                    when GDACS published this snapshot (RFC 2822)
 *   <gdacs:fromdate>             when the underlying event started (RFC 2822)
 *   <gdacs:eventtype>            EQ | FL | TC | VO | DR | WF
 *   <gdacs:eventid>              stable numeric id
 *   <gdacs:alertlevel>           Red | Orange | Green
 *   <gdacs:country>              affected country
 *   <geo:Point><geo:lat>/<geo:long>   coordinates
 *   <gdacs:bbox>                 "lonmin lonmax latmin latmax" (optional)
 */

const GDACS_URL = 'https://www.gdacs.org/xml/rss.xml'
const FETCH_TIMEOUT_MS = 15000

/** GDACS event-type code → our HazardType enum. */
const EVENT_TYPE_MAP = {
  EQ: 'earthquake',
  TS: 'tsunami',
  TC: 'cyclone',
  FL: 'flood',
  VO: 'volcano',
  DR: 'drought',
  // WF (wildfire) is intentionally omitted — GDACS publishes a very large
  // number of concurrent fire alerts globally (often >50% of the feed) and
  // they dominate the map without adding much to the Bangkok-flood demo
  // narrative. Drop them at the source so they never enter the pipeline.
}

/** GDACS alert level → our SeverityLevel enum. */
const ALERT_LEVEL_MAP = {
  Red:    'red',
  Orange: 'orange',
  Green:  'green',
}

/**
 * @returns {Promise<import('../../../src/types/fusion').CrisisEvent[]>}
 */
export async function fetchGdacs () {
  const res = await fetch(GDACS_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'verified-crisis-mapper/0.1 (+https://github.com/eukarya-biz/verified-crisis-mapper-demo)' },
  })
  if (!res.ok) throw new Error(`GDACS ${res.status} ${res.statusText}`)
  const xml = await res.text()
  return parseGdacsRss(xml)
}

/**
 * Pure parser — exported for unit testing without network access.
 * @param {string} xml
 * @returns {import('../../../src/types/fusion').CrisisEvent[]}
 */
export function parseGdacsRss (xml) {
  /** @type {import('../../../src/types/fusion').CrisisEvent[]} */
  const out = []
  const itemRegex = /<item\b[\s\S]*?<\/item>/g
  let match
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[0]
    const event = parseItem(block)
    if (event) out.push(event)
  }
  return out
}

/** @returns {import('../../../src/types/fusion').CrisisEvent | null} */
function parseItem (block) {
  const eventId   = pickText(block, 'gdacs:eventid')
  const typeCode  = pickText(block, 'gdacs:eventtype')
  const lat       = pickFloat(block, 'geo:lat')
  const lng       = pickFloat(block, 'geo:long')
  if (!eventId || !typeCode || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  // Drop wildfires — see EVENT_TYPE_MAP comment.
  if (typeCode === 'WF') return null

  const title       = decodeXmlEntities(pickText(block, 'title') ?? '')
  const description = decodeXmlEntities(pickText(block, 'description') ?? '')
  // Decode entities on the link too — GDACS emits `&amp;eventid=…` literally.
  const link        = decodeXmlEntities(pickText(block, 'link') ?? '')
  const pubDate     = pickText(block, 'pubDate')
  const fromDate    = pickText(block, 'gdacs:fromdate') ?? pubDate
  const alertLevel  = pickText(block, 'gdacs:alertlevel')
  const country     = pickText(block, 'gdacs:country')
  const iso3        = pickText(block, 'gdacs:iso3')?.toUpperCase()

  const hazardType = EVENT_TYPE_MAP[typeCode] ?? 'other'
  const severity   = alertLevel ? ALERT_LEVEL_MAP[alertLevel] : undefined

  return {
    eventId:     `gdacs-${typeCode}-${eventId}`,
    sourceType:  'gdacs',
    hazardType,
    title:       title || `${hazardType} in ${country ?? 'unknown'}`,
    description: description || undefined,
    lat,
    lng,
    occurredAt:  parseRfc2822(fromDate) ?? new Date().toISOString(),
    detectedAt:  parseRfc2822(pubDate)  ?? new Date().toISOString(),
    severity,
    url:         link || undefined,
    country:     iso3 || undefined,
    // sourceIntegrity & metadata get filled by trustScoreV2's priors;
    // geospatial gets a starting value here that the scorer may override.
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
  // Escape `:` for regex (no special meaning, but be explicit) and allow
  // self-closing tags by also matching `<tag />`. Capture group is the inner text.
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`)
  const m = block.match(re)
  if (!m) return null
  return m[1].trim()
}

function pickFloat (block, tag) {
  const t = pickText(block, tag)
  if (t === null) return NaN
  const n = parseFloat(t)
  return Number.isFinite(n) ? n : NaN
}

/** Parse an RFC 2822 date string into an ISO 8601 string, or null on failure. */
function parseRfc2822 (s) {
  if (!s) return null
  const ts = Date.parse(s)
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null
}

/** Decode the small set of XML entities GDACS uses in CDATA-free fields. */
function decodeXmlEntities (s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
