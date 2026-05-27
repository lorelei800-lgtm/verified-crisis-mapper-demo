export type DamageLevel = 'minimal' | 'partial' | 'destroyed'
export type InfraType =
  | 'residential'
  | 'commercial'
  | 'government'
  | 'utility'
  | 'transport'
  | 'community'
  | 'public_space'
  | 'other'
export type TrustTier = 'green' | 'amber' | 'red'
export type SubmissionChannel = 'pwa' | 'browser' | 'whatsapp'

export interface TrustScoreBreakdown {
  imageIntegrity: number   // 0–40
  geospatial: number       // 0–30
  crossReport: number      // 0–20
  metadata: number         // 0–10
  total: number            // 0–100
}

/**
 * Augmentation populated at display time when a citizen report falls inside
 * a verified webhook event's extent (currently Copernicus EMS only — its
 * satellite-derived footprints are the most defensible cross-source signal).
 * Surfaces in the Damage Card as a "✓ Confirmed by Copernicus EMS" badge
 * and feeds back into the Trust Score (crossReport gets +15, capped at 20).
 */
export interface CrossSourceMatch {
  sourceType: 'gdacs' | 'copernicus' | 'reliefweb'
  eventId:    string
  eventTitle: string
  eventUrl?:  string
}

export interface DamageReport {
  id: string
  cmsId?: string      // original CMS UUID — used for write-back operations
  lat: number
  lng: number
  damageLevel: DamageLevel
  infraType: InfraType
  landmark: string
  district: string
  timestamp: string        // ISO 8601
  channel: SubmissionChannel
  trustScore: TrustScoreBreakdown
  tier: TrustTier
  imageUrl?: string        // placeholder thumbnail
  h3Cell: string           // H3 resolution 9 cell index
  hasC2PA: boolean
  /** Populated by DashboardView at render time when within a Copernicus EMS footprint. */
  crossSourceMatch?: CrossSourceMatch
}

/**
 * Deployment configuration fetched from Re:Earth CMS `deployment-config` model.
 * Controls the app title, map bounds, and allowed reporting area.
 * Falls back to hardcoded defaults when CMS is not configured.
 */
export interface DeploymentConfig {
  // Display strings
  title:          string   // e.g. "Bangkok Flood Response"
  scenario_label: string   // e.g. "Bangkok Flood, October 2026" // legacy; new deployments prefer description
  subtitle:       string   // e.g. "Don Mueang / Pathum Thani"
  // Map initial view bounds
  bounds_sw_lat:  number
  bounds_sw_lng:  number
  bounds_ne_lat:  number
  bounds_ne_lng:  number
  // Allowed reporting area (centre + radius)
  area_center_lat: number
  area_center_lng: number
  area_radius_km:  number  // reports outside this radius get geo score = 0
  // Access control (managed from CMS — rotate PINs without touching code)
  // Note: stored in public-readable deployment-config; convenience gate, not crypto auth.
  admin_pin?:  string   // 6-digit PIN for Admin panel; fallback '000000' if not set
  viewer_pin?: string   // if set, Dashboard requires this PIN; open by default if unset
  // Localized damage level labels — override English defaults for regional deployments
  label_damage_minimal?:   string   // e.g. "被害軽微" / "Level 1" / "Catégorie 1"
  label_damage_partial?:   string
  label_damage_destroyed?: string
  // Schema simplification: new deployments use description; scenario_label kept for compat
  description?: string   // concise event+area string shown in header; falls back to scenario_label
}

export type ReviewStatus = 'approved' | 'rejected'
export type ReviewMap = Record<string, ReviewStatus>

export interface H3CellSummary {
  h3Index: string
  reports: DamageReport[]
  avgTrust: number
  dominantDamage: DamageLevel
}

// Re-export fusion types (Webhook-driven multi-source layer)
export type {
  SourceType,
  HazardType,
  SeverityLevel,
  VerifiedTrustScore,
  Lineage,
  CrisisEvent,
  FusedEvent,
  GeoJSONPolygon,
  GeoJSONMultiPolygon,
} from './fusion'
