/**
 * Client-side data export — GeoJSON and CSV.
 *
 * Backs the proposal's "GeoJSON / CSV export for interoperability with WFP,
 * OCHA, HDX, KoboToolbox" claim and satisfies the InnoCentive attachment
 * requirement that the pitch video demonstrate data export. Everything runs
 * in the browser (no backend) — the currently-visible citizen reports and
 * fused verified events are serialized and downloaded.
 */
import type { DamageReport, FusedEvent } from '../types'

function triggerDownload(filename: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Download citizen reports + verified events as a single GeoJSON FeatureCollection. */
export function downloadGeoJSON(reports: DamageReport[], events: FusedEvent[]) {
  const features = [
    ...reports.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.lng, r.lat] },
      properties: {
        kind: 'citizen_report',
        id: r.id,
        damage_level: r.damageLevel,
        infrastructure: r.infraType,
        landmark: r.landmark,
        tier: r.tier,
        trust_score: r.trustScore.total,
        channel: r.channel,
        timestamp: r.timestamp,
      },
    })),
    ...events.map(e => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [e.lng, e.lat] },
      properties: {
        kind: 'verified_event',
        id: e.eventId,
        source: e.sourceType,
        hazard: e.hazardType,
        title: e.title,
        trust_score: e.trustScore.total,
        source_count: e.sourceCount,
        occurred_at: e.occurredAt,
      },
    })),
  ]
  const fc = { type: 'FeatureCollection' as const, features }
  triggerDownload('verified-crisis-mapper.geojson', 'application/geo+json', JSON.stringify(fc, null, 2))
}

/** Download citizen reports as CSV (one row per report). */
export function downloadCSV(reports: DamageReport[]) {
  const cols = ['id', 'lat', 'lng', 'damage_level', 'infrastructure', 'landmark', 'tier', 'trust_score', 'channel', 'timestamp']
  const esc = (v: unknown) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = reports.map(r => [
    r.id, r.lat, r.lng, r.damageLevel, r.infraType, r.landmark, r.tier, r.trustScore.total, r.channel, r.timestamp,
  ].map(esc).join(','))
  triggerDownload('verified-crisis-mapper.csv', 'text/csv', [cols.join(','), ...rows].join('\n'))
}
