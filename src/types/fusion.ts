/**
 * Types for the multi-source crisis-data fusion pipeline.
 *
 * Background
 * ----------
 * The original Verified Crisis Mapper covered only citizen-submitted damage
 * reports. The fusion layer adds three more channels — GDACS alerts,
 * Copernicus EMS rapid-mapping activations, and ReliefWeb situation reports —
 * so the dashboard is useful in the 0–2 hours after a disaster, before
 * citizens can physically file reports.
 *
 * All three webhook sources are **multi-hazard**: they cover earthquakes,
 * tsunamis, cyclones, floods, volcanoes, droughts, and wildfires (the exact
 * mix differs per source). The Bangkok Flood scenario is just one concrete
 * demonstration; the same wiring carries any future deployment.
 *
 * These types are imported by both the React app (Dashboard source filter,
 * lineage card) and the Node-side fetcher scripts in `demo/scripts/fusion/`.
 */

/** Where a piece of data came from. */
export type SourceType = 'citizen' | 'gdacs' | 'copernicus' | 'reliefweb'

/**
 * What kind of disaster the event describes. Aligned with GDACS event-type
 * codes where possible (EQ → earthquake, TC → cyclone, FL → flood, VO →
 * volcano, DR → drought, WF → wildfire); 'other' is the catch-all.
 */
export type HazardType =
  | 'earthquake'
  | 'tsunami'
  | 'cyclone'    // tropical cyclone / hurricane / typhoon
  | 'flood'
  | 'volcano'
  | 'drought'
  | 'wildfire'
  | 'other'

/** Severity classification — aligns with GDACS Red/Orange/Green alert levels. */
export type SeverityLevel = 'red' | 'orange' | 'green'

/**
 * Source-side trust contribution. Same 40/30/20/10 weighting as the existing
 * citizen Trust Score in `utils/trustScore.ts`, but each factor is interpreted
 * differently for webhook sources (see `trustScoreV2.ts`).
 */
export interface VerifiedTrustScore {
  /** Source authenticity (HTTPS signature, known publisher, etc.) — 0–40 */
  sourceIntegrity: number
  /** Geospatial consistency (e.g. satellite vs reported area) — 0–30 */
  geospatial: number
  /** Cross-source agreement at the same H3 cell within ±30min — 0–20 */
  crossSource: number
  /** Source reliability prior × metadata completeness — 0–10 */
  metadata: number
  /** Sum, clamped to 0–100 */
  total: number
}

/**
 * Audit trail for a fused/verified event — which source events were merged in.
 * Lets the Dashboard show "this event is corroborated by GDACS + Copernicus
 * EMS + 3 citizen reports" without losing the underlying provenance.
 */
export interface Lineage {
  fusedFrom: Array<{
    sourceType: SourceType
    /** Stable id within the source, e.g. "gdacs-EQ-1462184" */
    eventId: string
    /** Optional canonical link back to the source record */
    url?: string
    /** When the source originally published the record (ISO 8601) */
    detectedAt: string
  }>
}

/**
 * A normalized crisis event from any single source — produced by
 * `sources/{gdacs,copernicus,reliefweb}.ts` before deduplication.
 *
 * Coordinates are required. Sources that publish only a polygon (e.g.
 * Copernicus EMS flood extent) populate `affectedArea` and use the polygon
 * centroid for (lat, lng).
 */
export interface CrisisEvent {
  /** Stable identifier within the source, e.g. "gdacs-EQ-1462184" */
  eventId: string
  sourceType: SourceType
  hazardType: HazardType
  /** Short human-readable summary (one line). */
  title: string
  /** Longer description if the source provides one. */
  description?: string
  lat: number
  lng: number
  /** H3 res 8 cell index (~0.74 km²) — assigned by `normalizer.ts`. */
  h3Cell?: string
  /** When the event itself occurred (ISO 8601). */
  occurredAt: string
  /** When the source published the record (ISO 8601). */
  detectedAt: string
  severity?: SeverityLevel
  /** Canonical link to the source page / record. */
  url?: string
  /**
   * ISO 3166-1 alpha-3 country code (e.g. "THA"). Used as a fallback
   * matching key during deduplication when sources have very different
   * spatial resolutions — GDACS reports precise event coords while
   * ReliefWeb only has country centroids, so the H3 cells never match.
   */
  country?: string
  /** Optional polygon describing the affected region (GeoJSON Polygon / MultiPolygon). */
  affectedArea?: GeoJSONPolygon | GeoJSONMultiPolygon
  trustScore: VerifiedTrustScore
}

/**
 * After fusion: a single verified event that aggregates one-or-more source
 * `CrisisEvent`s landing in the same H3 cell within a ±30-minute window.
 *
 * This is the shape stored in the Re:Earth CMS `verified-events` model and
 * the shape consumed by the Dashboard.
 */
export interface FusedEvent extends CrisisEvent {
  /** True iff this event aggregates 2+ distinct sources. */
  isFused: boolean
  /** Distinct-source count (1 for unfused / single-source records). */
  sourceCount: number
  /** Audit trail — which source events were merged in. */
  lineage: Lineage
}

// ── Minimal GeoJSON shapes (we don't pull in @types/geojson just for this) ──

export interface GeoJSONPolygon {
  type: 'Polygon'
  /** Ring coordinates: [[ [lng, lat], [lng, lat], ... ]] */
  coordinates: Array<Array<[number, number]>>
}

export interface GeoJSONMultiPolygon {
  type: 'MultiPolygon'
  coordinates: Array<Array<Array<[number, number]>>>
}
