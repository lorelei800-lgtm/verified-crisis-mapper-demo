/**
 * Re:Earth CMS REST API client
 *
 * Re:Earth CMS public API reference:
 *   GET  /api/projects/{project}/models/{model}/items   → list items
 *   POST /api/projects/{project}/models/{model}/items   → create item  (auth required)
 *   POST /api/projects/{project}/assets                 → upload asset (auth required)
 *
 * The public read API returns items with every field exposed as a top-level key.
 * Asset fields return the full asset object { id, url, name, contentType }.
 * Write operations expect:  { "fields": [{ "key": "...", "value": ... }] }
 */

import { CMS } from '../config'
import type { DamageReport, DamageLevel, InfraType, SubmissionChannel, TrustTier, DeploymentConfig, ReviewStatus, ReviewMap } from '../types'
import { getTier } from '../utils/trustScore'

// ─── Deployment defaults ─────────────────────────────────────────────────────

export const DEFAULT_CONFIG: DeploymentConfig = {
  title:           'Bangkok Flood Response',
  scenario_label:  'Bangkok Flood, Chao Phraya Basin, October 2026',
  subtitle:        'Don Mueang / Bang Sue',
  bounds_sw_lat:   13.75,
  bounds_sw_lng:   100.50,
  bounds_ne_lat:   14.06,
  bounds_ne_lng:   100.66,
  area_center_lat: 13.89,
  area_center_lng: 100.58,
  area_radius_km:  18,
}

// ─── CMS response shapes ────────────────────────────────────────────────────

interface CmsAsset {
  id: string
  url: string
  name?: string
  contentType?: string
}

/**
 * Shape of one item returned by the Re:Earth CMS public API.
 * Fields are exposed as top-level keys; asset fields include the full asset object.
 */
interface CmsItem {
  id: string
  createdAt?: string
  updatedAt?: string
  // Some Re:Earth CMS deployments expose timestamps as snake_case at the
  // top level rather than camelCase — accept either so the dashboard "Time"
  // row doesn't show as blank after a fresh bootstrap-bangkok run.
  created_at?: string
  updated_at?: string
  // damage report fields ↓
  damage_level?: string
  infra_type?: string
  landmark?: string
  district?: string
  lat?: number
  lng?: number
  channel?: string
  has_c2pa?: boolean
  h3_cell?: string
  image?: CmsAsset | null
  /** Optional explicit scenario timestamp (seeded by bootstrap-bangkok.mjs). */
  timestamp?: string
  trust_score_total?: number
  trust_score_image?: number
  trust_score_geo?: number
  trust_score_cross?: number
  trust_score_meta?: number
  tier?: string
  review_status?: string   // 'approved' | 'rejected' | '' — written by admin
  reject_reason?: string   // free-text reason set when admin rejects
}

interface CmsListResponse {
  results: CmsItem[]   // Re:Earth CMS public API uses "results", not "items"
  totalCount: number
}

// ─── Mapping ────────────────────────────────────────────────────────────────

/**
 * Derive a stable, plausible disaster-day timestamp from the item id when CMS
 * doesn't expose one. Re:Earth's damage-report schema may not include a
 * `timestamp` field, so the value posted by the bootstrap script is silently
 * dropped; and the public read API doesn't expose `createdAt` either. Without
 * this fallback the "Time" column reads blank for every CMS-seeded row.
 *
 * The hash is deterministic, so the same id always maps to the same time —
 * pins keep their visual identity across page reloads and sort-by-time
 * orders the same way each time.
 *
 * Range: 2026-10-14 06:00 → 18:00 UTC (the Bangkok-flood scenario window).
 */
function fallbackTimestampFromId(id: string): string {
  if (!id) return ''
  // djb2 hash → 0..2^31
  let h = 5381
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) + h + id.charCodeAt(i)) & 0x7fffffff
  }
  const start = Date.UTC(2026, 9, 14,  6, 0, 0)
  const end   = Date.UTC(2026, 9, 14, 18, 0, 0)
  const ratio = h / 0x7fffffff
  return new Date(start + Math.floor((end - start) * ratio)).toISOString()
}

function cmsItemToReport(item: CmsItem): DamageReport {
  const total          = item.trust_score_total ?? 0
  const imageIntegrity = item.trust_score_image ?? 0
  const geospatial     = item.trust_score_geo   ?? 0
  const crossReport    = item.trust_score_cross  ?? 0
  const metadata       = item.trust_score_meta   ?? 0

  return {
    id:         `CMS-${item.id.replace(/-/g, '').slice(-6).toUpperCase()}`,
    cmsId:      item.id,   // keep original UUID for write-back
    lat:        item.lat ?? 0,
    lng:        item.lng ?? 0,
    damageLevel:(item.damage_level as DamageLevel)     ?? 'minimal',
    infraType:  (item.infra_type   as InfraType)       ?? 'other',
    landmark:   item.landmark  ?? '',
    district:   item.district  ?? '',
    // Prefer the scenario-provided timestamp (seeded by bootstrap), then the
    // CMS's own creation time in either camel or snake case. As a last resort
    // derive a stable disaster-day timestamp from the item id so the "Time"
    // column is never blank for CMS-seeded rows whose schema doesn't carry
    // a timestamp field.
    timestamp:  item.timestamp ?? item.createdAt ?? item.created_at ?? fallbackTimestampFromId(item.id),
    channel:    (item.channel  as SubmissionChannel)   ?? 'browser',
    hasC2PA:    item.has_c2pa  ?? false,
    h3Cell:     item.h3_cell   ?? '',
    imageUrl:   item.image?.url ?? undefined,
    trustScore: { total, imageIntegrity, geospatial, crossReport, metadata },
    tier:       (item.tier as TrustTier) ?? getTier(total),
  }
}

// ─── Public API: read ────────────────────────────────────────────────────────

/**
 * Fetch all damage reports from Re:Earth CMS.
 * Also returns a ReviewMap extracted from the `review_status` field of each item.
 * Returns { reports: [], reviewMap: {} } if CMS is not configured or the request fails.
 */
export async function fetchCmsReports(): Promise<{ reports: DamageReport[]; reviewMap: ReviewMap }> {
  if (!CMS.enabled) return { reports: [], reviewMap: {} }

  const url = `${CMS.baseUrl}/api/p/${CMS.project}/${CMS.model}?perPage=100`

  try {
    // 10s timeout protects against hung connections on slow / lossy networks
    // (pattern borrowed from SANPO app — same Re:Earth CMS public read API)
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)

    const data: CmsListResponse = await res.json()
    console.info(`[CMS] fetchReports: totalCount=${data.totalCount}, returned=${data.results.length}`)

    const reports = data.results.map(cmsItemToReport)

    // Build a ReviewMap from the review_status field stored in each CMS item
    const reviewMap: ReviewMap = {}
    data.results.forEach(item => {
      if (item.review_status === 'approved' || item.review_status === 'rejected') {
        const displayId = `CMS-${item.id.replace(/-/g, '').slice(-6).toUpperCase()}`
        reviewMap[displayId] = item.review_status as ReviewStatus
      }
    })

    return { reports, reviewMap }
  } catch (err) {
    console.warn('[CMS] fetchReports failed — using mock data', err)
    return { reports: [], reviewMap: {} }
  }
}

// ─── Public API: deployment config ──────────────────────────────────────────

// ─── Shared config parser ────────────────────────────────────────────────────

function parseConfigItem(item: Record<string, unknown>): DeploymentConfig {
  const n = (key: string, fallback: number): number =>
    typeof item[key] === 'number' ? (item[key] as number) : fallback
  const s = (key: string, fallback: string): string =>
    typeof item[key] === 'string' ? (item[key] as string) : fallback
  const sOpt = (key: string): string | undefined =>
    typeof item[key] === 'string' && (item[key] as string) !== '' ? (item[key] as string) : undefined

  return {
    title:                   s('title',           DEFAULT_CONFIG.title),
    scenario_label:          s('scenario_label',  DEFAULT_CONFIG.scenario_label),
    subtitle:                s('subtitle',        DEFAULT_CONFIG.subtitle),
    bounds_sw_lat:           n('bounds_sw_lat',   DEFAULT_CONFIG.bounds_sw_lat),
    bounds_sw_lng:           n('bounds_sw_lng',   DEFAULT_CONFIG.bounds_sw_lng),
    bounds_ne_lat:           n('bounds_ne_lat',   DEFAULT_CONFIG.bounds_ne_lat),
    bounds_ne_lng:           n('bounds_ne_lng',   DEFAULT_CONFIG.bounds_ne_lng),
    area_center_lat:         n('area_center_lat', DEFAULT_CONFIG.area_center_lat),
    area_center_lng:         n('area_center_lng', DEFAULT_CONFIG.area_center_lng),
    area_radius_km:          n('area_radius_km',  DEFAULT_CONFIG.area_radius_km),
    admin_pin:               sOpt('admin_pin'),
    viewer_pin:              sOpt('viewer_pin'),
    label_damage_minimal:    sOpt('label_damage_minimal'),
    label_damage_partial:    sOpt('label_damage_partial'),
    label_damage_destroyed:  sOpt('label_damage_destroyed'),
    description:             sOpt('description'),
  }
}

/**
 * Fetch the deployment configuration from Re:Earth CMS `deployment-config` model.
 * Returns DEFAULT_CONFIG when CMS is not configured or the fetch fails.
 */
export async function fetchDeploymentConfig(): Promise<DeploymentConfig> {
  if (!CMS.enabled) return DEFAULT_CONFIG

  // Re:Earth CMS public model alias is `deployment-config` by convention
  const url = `${CMS.baseUrl}/api/p/${CMS.project}/deployment-config`

  try {
    // Public read API — no Authorization header needed (and rejected if sent).
    // 10s timeout protects against hung connections (see fetchCmsReports for context).
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)

    const data: { results: Array<Record<string, unknown>> } = await res.json()
    const item = data.results?.[0]
    if (!item) return DEFAULT_CONFIG

    return parseConfigItem(item)
  } catch (err) {
    console.warn('[CMS] fetchDeploymentConfig failed — using defaults', err)
    return DEFAULT_CONFIG
  }
}

export async function fetchAllScenarios(): Promise<DeploymentConfig[]> {
  if (!CMS.enabled) return [DEFAULT_CONFIG]
  const url = `${CMS.baseUrl}/api/p/${CMS.project}/deployment-config?perPage=100`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const data: { results: Array<Record<string, unknown>> } = await res.json()
    const items = data.results ?? []
    if (items.length === 0) return [DEFAULT_CONFIG]
    return items.map(parseConfigItem)
  } catch (err) {
    console.warn('[CMS] fetchAllScenarios failed — using default', err)
    return [DEFAULT_CONFIG]
  }
}

// ─── Authenticated API: write ────────────────────────────────────────────────

/**
 * Upload a photo file as a CMS asset.
 * Returns the asset object (including .url) on success, null on failure.
 */
/** Split "workspace/project" alias stored in VITE_CMS_PROJECT */
function splitProject(): [string, string] {
  const parts = (CMS.project ?? '').split('/')
  return [parts[0] ?? '', parts[1] ?? '']
}

/**
 * Write the admin review status back to a CMS item.
 * Uses the Integration API (requires CMS.token).
 */
export async function updateReviewStatus(
  cmsItemId: string,
  status: ReviewStatus | null,
  rejectReason?: string,
): Promise<boolean> {
  if (!CMS.writable) {
    console.warn('[CMS] updateReviewStatus: CMS not writable (no token)')
    return false
  }
  const [ws, proj] = splitProject()
  // Must use the /models/{model}/ path — bare /items/{id} returns 404
  const url = `${CMS.baseUrl}/api/${ws}/projects/${proj}/models/${CMS.model}/items/${cmsItemId}`

  const fields: Array<{ key: string; value: unknown }> = [
    { key: 'review_status', value: status ?? '' },
  ]
  // Always write reject_reason — clear it when approving, set it when rejecting
  if (status === 'rejected' && rejectReason) {
    fields.push({ key: 'reject_reason', value: rejectReason })
  } else if (status === 'approved') {
    fields.push({ key: 'reject_reason', value: '' })
  }

  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization:  `Bearer ${CMS.token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ fields }),
    })
    console.info(`[CMS] updateReviewStatus ${cmsItemId} → ${status} : HTTP ${res.status}`)
    if (!res.ok) return false

    // Re:Earth CMS reverts items to "draft" after a PATCH, so re-publish immediately.
    // Without this, the updated item disappears from the public read API on other devices.
    const publishUrl = `${CMS.baseUrl}/api/${ws}/projects/${proj}/models/${CMS.model}/items/${cmsItemId}/publish`
    const pubRes = await fetch(publishUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CMS.token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
      body: '{}',
    })
    console.info(`[CMS] updateReviewStatus re-publish → ${pubRes.status}`)
    return true
  } catch (err) {
    console.warn('[CMS] updateReviewStatus failed', err)
    return false
  }
}

export async function uploadAsset(file: File): Promise<CmsAsset | null> {
  if (!CMS.writable) return null

  // Integration API: /api/{workspace}/projects/{project}/assets
  const [ws, proj] = splitProject()
  const url = `${CMS.baseUrl}/api/${ws}/projects/${proj}/assets`
  const body = new FormData()
  body.append('file', file)
  body.append('name', file.name || 'damage-photo.jpg')

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CMS.token}` },
      signal: AbortSignal.timeout(60000),   // 60s — mobile photo upload on slow networks
      body,
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const asset = await res.json() as Partial<CmsAsset> & { previewUrl?: string }
    // Defensive: some CMS deployments return previewUrl instead of url, or
    // omit url entirely on async-processed assets. Treat any of url/previewUrl
    // as success; otherwise log and return null so caller can fall back.
    const assetUrl = asset.url ?? asset.previewUrl
    if (!asset.id || !assetUrl) {
      console.warn('[CMS] uploadAsset: response missing id/url', asset)
      return null
    }
    return { id: asset.id, url: assetUrl, name: asset.name, contentType: asset.contentType }
  } catch (err) {
    console.warn('[CMS] uploadAsset failed', err)
    return null
  }
}

/**
 * Create a damage report item in Re:Earth CMS.
 * Returns the CMS item ID on success, null on failure.
 *
 * @param report  The DamageReport to persist
 * @param assetId The CMS asset ID for the photo (from uploadAsset), if available
 */
export async function createReportItem(
  report: DamageReport,
  assetId?: string,
): Promise<string | null> {
  if (!CMS.writable) return null

  // Integration API: /api/{workspace}/projects/{project}/models/{model}/items
  const [ws, proj] = splitProject()
  const url = `${CMS.baseUrl}/api/${ws}/projects/${proj}/models/${CMS.model}/items`

  // Re:Earth CMS write API expects an array of { key, value } field objects.
  // The `timestamp` field is included so the dashboard can display when the
  // report was actually filed (rather than falling back to a hash of the id).
  // Requires the damage-report model to declare a text field with key
  // `timestamp` — if the schema lacks it, the write is silently ignored by
  // Re:Earth CMS and the dashboard fallback kicks in (see fallbackTimestampFromId).
  const fields: Array<{ key: string; value: unknown }> = [
    { key: 'timestamp',          value: report.timestamp || new Date().toISOString() },
    { key: 'damage_level',       value: report.damageLevel },
    { key: 'infra_type',         value: report.infraType },
    { key: 'landmark',           value: report.landmark },
    { key: 'district',           value: report.district },
    { key: 'lat',                value: report.lat },
    { key: 'lng',                value: report.lng },
    { key: 'channel',            value: report.channel },
    { key: 'has_c2pa',           value: report.hasC2PA },
    { key: 'h3_cell',            value: report.h3Cell },
    { key: 'tier',               value: report.tier },
    { key: 'trust_score_total',  value: report.trustScore.total },
    { key: 'trust_score_image',  value: report.trustScore.imageIntegrity },
    { key: 'trust_score_geo',    value: report.trustScore.geospatial },
    { key: 'trust_score_cross',  value: report.trustScore.crossReport },
    { key: 'trust_score_meta',   value: report.trustScore.metadata },
  ]

  if (assetId) {
    fields.push({ key: 'image', value: assetId })
  }

  try {
    // Step 1: Create the item
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${CMS.token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ fields }),
    })
    console.info(`[CMS] create → ${res.status}, content-length: ${res.headers.get('content-length')}, location: ${res.headers.get('location')}`)

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      console.warn(`[CMS] createReportItem ${res.status}:`, errBody)
      throw new Error(`${res.status} ${res.statusText}`)
    }

    // Try to extract item ID from response body or Location header
    let itemId: string | null = null

    // Try Location header first (e.g. "Location: /api/.../items/xxxx")
    const location = res.headers.get('location')
    if (location) {
      const m = location.match(/items\/([^/?]+)/)
      if (m) itemId = m[1]
    }

    // Try response body
    if (!itemId && res.status !== 204) {
      const text = await res.text().catch(() => '')
      console.info('[CMS] create body:', text.slice(0, 200))
      if (text) {
        try {
          const data = JSON.parse(text) as { id?: string }
          itemId = data.id ?? null
        } catch { /* ignore parse errors */ }
      }
    }

    // Fallback: fetch the newest item from Integration API to get its ID
    if (!itemId) {
      console.info('[CMS] no ID in response — fetching newest item to publish')
      await new Promise(r => setTimeout(r, 800))
      // Try multiple sort parameters to get newest item first
      const listUrl = `${url}?perPage=5&sort=createdAt&direction=desc`
      const listRes = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${CMS.token}` },
        signal: AbortSignal.timeout(10000),
      })
      if (listRes.ok) {
        const listData = await listRes.json() as {
          items?:   { id: string; status?: string; createdAt?: string }[]
          results?: { id: string; status?: string; createdAt?: string }[]
          totalCount?: number
        }
        const allItems = [...(listData.items ?? []), ...(listData.results ?? [])]
        console.info('[CMS] list response keys:', Object.keys(listData), 'totalCount:', listData.totalCount, 'items:', allItems.length)
        // Prefer first draft item; fall back to newest regardless of status
        const draftItem = allItems.find(i => i.status !== 'public')
        itemId = draftItem?.id ?? allItems[0]?.id ?? null
        console.info('[CMS] selected item to publish:', itemId, 'status:', draftItem?.status)
      }
    }

    console.info('[CMS] itemId to publish:', itemId)

    // Step 2: Publish — retry once on failure
    if (itemId) {
      const publishUrl = `${CMS.baseUrl}/api/${ws}/projects/${proj}/models/${CMS.model}/items/${itemId}/publish`
      let published = false

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const pubRes = await fetch(publishUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${CMS.token}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(15000),
            body: '{}',
          })
          console.info(`[CMS] publish attempt ${attempt + 1} → ${pubRes.status}`)
          if (pubRes.ok) { published = true; break }
          if (attempt === 0) await new Promise(r => setTimeout(r, 1500))   // wait before retry
        } catch (e) {
          console.warn(`[CMS] publish attempt ${attempt + 1} threw`, e)
          if (attempt === 0) await new Promise(r => setTimeout(r, 1500))
        }
      }

      if (!published) {
        // Item was created in CMS but is in draft state — NOT visible on public API
        // Return null so the caller sets cmsSyncStatus='error' rather than 'synced'
        console.warn('[CMS] publish failed after retry — item is in draft, not public')
        return null
      }
    }

    return itemId ?? null
  } catch (err) {
    console.warn('[CMS] createReportItem failed', err)
    return null
  }
}
