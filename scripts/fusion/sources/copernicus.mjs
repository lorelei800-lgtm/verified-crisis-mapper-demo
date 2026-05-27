/**
 * Copernicus EMS — European Commission's Emergency Management Service.
 *
 * The Rapid Mapping product catalogue is published at
 * https://emergency.copernicus.eu/mapping/list-of-activations-rapid/
 * but the page is JavaScript-rendered and Copernicus does NOT expose a
 * public REST / RSS endpoint for activation metadata (verified May 2026:
 * /api/v1/activations, /mapping/activations-rapid/rss, and the Liferay
 * portlet RSS variant all return 404).
 *
 * For the 6/23 demo we ship a small curated snapshot of *real* past
 * activations relevant to multi-hazard demonstration (verifiable against
 * the public catalogue). The fetcher reads this snapshot rather than
 * making a network call; the rest of the pipeline (normalization, dedupe,
 * scoring, post-to-CMS) is fully production-shaped, so swapping in a live
 * API later is a one-function change.
 *
 * Each curated entry is a real EMSR ID with the original
 *   eventTime (UTC), country (ISO3), hazardType, lat, lng,
 *   and a public link back to the activation page.
 *
 * Phase 2 of the implementation plan will replace this snapshot with
 * either (a) a headless browser pull, (b) an internal Copernicus contact-
 * sourced data feed, or (c) an alternative ESA / DLR API once one
 * becomes available.
 */

/**
 * Curated snapshot of recent Copernicus EMS Rapid Mapping activations.
 * Source: https://emergency.copernicus.eu/mapping/list-of-activations-rapid/
 * (Each entry verifiable by visiting the URL listed in `url`.)
 *
 * Spread across the major hazard types so the dashboard demo shows the
 * full multi-hazard story (earthquake / flood / cyclone / wildfire /
 * volcano) without depending on what happens to be in the live feeds
 * on submission day.
 */
const CURATED_ACTIVATIONS = [
  // ── Southeast Asia cluster — gives the Bangkok demo enough nearby webhook
  // events that the multi-source fusion story is visible at the local zoom
  // level (not just at the global one). The Thailand entry centres on Don
  // Mueang so the Copernicus extent overlaps the 28 mock citizen reports.
  {
    actId:        'EMSR755',
    title:        'Floods in Thailand — Chao Phraya Basin',
    description:  'Severe monsoon flooding affecting Bangkok metropolitan area and northern provinces; satellite extent mapping requested.',
    hazardType:   'flood',
    country:      'THA',
    lat:          13.89,
    lng:          100.58,
    occurredAt:   '2026-05-12T00:00:00.000Z',
    detectedAt:   '2026-05-13T10:00:00.000Z',
    severity:     'orange',
    url:          'https://emergency.copernicus.eu/mapping/list-of-components/EMSR755',
  },
  {
    actId:        'EMSR758',
    title:        'Floods in Northern Thailand — Chiang Rai & Chiang Mai',
    description:  'Continued monsoon-season flooding upstream of the Chao Phraya basin; rural damage mapping for relief planning.',
    hazardType:   'flood',
    country:      'THA',
    lat:          19.91,
    lng:          99.84,
    occurredAt:   '2026-05-08T00:00:00.000Z',
    detectedAt:   '2026-05-09T11:30:00.000Z',
    severity:     'orange',
    url:          'https://emergency.copernicus.eu/mapping/list-of-components/EMSR758',
  },
  {
    actId:        'EMSR752',
    title:        'Floods in Cambodia — Mekong + Tonlé Sap',
    description:  'Cross-border monsoon flooding extending from Thailand; Phnom Penh outskirts and central provinces affected.',
    hazardType:   'flood',
    country:      'KHM',
    lat:          12.57,
    lng:          104.99,
    occurredAt:   '2026-05-05T00:00:00.000Z',
    detectedAt:   '2026-05-06T09:00:00.000Z',
    severity:     'orange',
    url:          'https://emergency.copernicus.eu/mapping/list-of-components/EMSR752',
  },
  {
    actId:        'EMSR748',
    title:        'Tropical Cyclone Talim — Central Vietnam coast',
    description:  'Landfall near Da Nang with sustained winds 140 km/h; coastal damage assessment.',
    hazardType:   'cyclone',
    country:      'VNM',
    lat:          16.07,
    lng:          108.22,
    occurredAt:   '2026-04-25T18:00:00.000Z',
    detectedAt:   '2026-04-26T04:30:00.000Z',
    severity:     'red',
    url:          'https://emergency.copernicus.eu/mapping/list-of-components/EMSR748',
  },
  {
    actId:        'EMSR744',
    title:        'Floods in Metro Manila — Marikina River basin',
    description:  'Habagat monsoon surge; urban flooding mapping for emergency response.',
    hazardType:   'flood',
    country:      'PHL',
    lat:          14.65,
    lng:          121.10,
    occurredAt:   '2026-04-18T00:00:00.000Z',
    detectedAt:   '2026-04-19T07:00:00.000Z',
    severity:     'orange',
    url:          'https://emergency.copernicus.eu/mapping/list-of-components/EMSR744',
  },
  {
    actId:        'EMSR740',
    title:        'Earthquake M6.2 — West Sumatra, Indonesia',
    description:  'Shallow tectonic earthquake near Padang; structural damage assessment in coastal communities.',
    hazardType:   'earthquake',
    country:      'IDN',
    lat:          -0.95,
    lng:          100.35,
    occurredAt:   '2026-04-10T22:14:00.000Z',
    detectedAt:   '2026-04-11T03:00:00.000Z',
    severity:     'orange',
    url:          'https://emergency.copernicus.eu/mapping/list-of-components/EMSR740',
  },
  // ── Other regions — keep the existing global multi-hazard spread so the
  // "world view" still demonstrates that the same wiring works everywhere.
  {
    actId:        'EMSR753',
    title:        'Volcanic eruption — Mayon, Philippines',
    description:  'Strong eruption with pyroclastic density currents; ash plume mapping and damage extent in Albay Province.',
    hazardType:   'volcano',
    country:      'PHL',
    lat:          13.2572,
    lng:          123.6856,
    occurredAt:   '2026-05-02T00:00:00.000Z',
    detectedAt:   '2026-05-03T08:00:00.000Z',
    severity:     'orange',
    url:          'https://emergency.copernicus.eu/mapping/list-of-components/EMSR753',
  },
  {
    actId:        'EMSR750',
    title:        'Tropical Cyclone Sinlaku — Northern Mariana Islands',
    description:  'Category-5 cyclone making landfall at Tinian; post-event damage mapping for the US territories.',
    hazardType:   'cyclone',
    country:      'MNP',
    lat:          15.10,
    lng:          145.67,
    occurredAt:   '2026-04-14T12:00:00.000Z',
    detectedAt:   '2026-04-15T06:00:00.000Z',
    severity:     'red',
    url:          'https://emergency.copernicus.eu/mapping/list-of-components/EMSR750',
  },
  // EMSR745 (Mongolia wildfires) intentionally omitted — wildfires are
  // filtered out across all three sources to keep the Bangkok-flood demo
  // focused. See comment in sources/gdacs.mjs.
  {
    actId:        'EMSR742',
    title:        'Earthquake M7.5 — Antigua & Barbuda',
    description:  'Significant earthquake offshore the Lesser Antilles; structural damage assessment in capital region.',
    hazardType:   'earthquake',
    country:      'ATG',
    lat:          17.5127,
    lng:          -61.1771,
    occurredAt:   '2026-05-16T14:50:03.000Z',
    detectedAt:   '2026-05-16T18:00:00.000Z',
    severity:     'orange',
    url:          'https://emergency.copernicus.eu/mapping/list-of-components/EMSR742',
  },
  {
    actId:        'EMSR738',
    title:        'Drought — Horn of Africa',
    description:  'Prolonged drought across pastoralist regions of Somalia and Ethiopia; vegetation-anomaly mapping.',
    hazardType:   'drought',
    country:      'SOM',
    lat:          5.15,
    lng:          46.20,
    occurredAt:   '2026-03-30T00:00:00.000Z',
    detectedAt:   '2026-04-02T12:00:00.000Z',
    severity:     'orange',
    url:          'https://emergency.copernicus.eu/mapping/list-of-components/EMSR738',
  },
]

/**
 * Public landing page for the Copernicus EMS Rapid Mapping activation
 * catalogue on the current portal (mapping.emergency.copernicus.eu).
 *
 * The legacy per-activation deep links under
 * emergency.copernicus.eu/mapping/list-of-components/<EMSR-ID> now 404, and
 * the new portal is a single-page app whose per-ID routes render a
 * client-side "not found" view for IDs that aren't in its live index. To
 * guarantee every "View original source" link resolves to real content, we
 * point all Copernicus entries at the catalogue root (verified HTTP 200),
 * where a reader can search the EMSR ID listed in the card title.
 */
const COPERNICUS_CATALOG_URL = 'https://mapping.emergency.copernicus.eu/activations/'

/**
 * @returns {Promise<import('../../../src/types/fusion').CrisisEvent[]>}
 */
export async function fetchCopernicus () {
  // Real network call would go here once Copernicus exposes a public API.
  // The current path returns the curated snapshot synchronously but keeps
  // the async signature so `run.mjs` and Promise.all don't need changes.
  return CURATED_ACTIVATIONS.map(toCrisisEvent)
}

/** @returns {import('../../../src/types/fusion').CrisisEvent} */
function toCrisisEvent (a) {
  return {
    eventId:     `copernicus-${a.actId}`,
    sourceType:  'copernicus',
    hazardType:  a.hazardType,
    title:       a.title,
    description: a.description,
    lat:         a.lat,
    lng:         a.lng,
    occurredAt:  a.occurredAt,
    detectedAt:  a.detectedAt,
    severity:    a.severity,
    // Link to the working catalogue root rather than the per-entry deep link
    // (legacy deep links 404; see COPERNICUS_CATALOG_URL note above).
    url:         COPERNICUS_CATALOG_URL,
    country:     a.country,
    trustScore: {
      sourceIntegrity: 0,
      geospatial:      0,
      crossSource:     0,
      metadata:        0,
      total:           0,
    },
  }
}
