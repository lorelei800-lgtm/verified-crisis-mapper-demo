import type { TrustScoreBreakdown, TrustTier, SubmissionChannel } from '../types'

export function getTier(score: number): TrustTier {
  if (score >= 80) return 'green'
  if (score >= 50) return 'amber'
  return 'red'
}

export function getTierLabel(tier: TrustTier): string {
  switch (tier) {
    case 'green': return 'High Trust'
    case 'amber': return 'Under Review'
    case 'red': return 'Human Review Required'
  }
}

export function getTierDescription(tier: TrustTier): string {
  switch (tier) {
    case 'green': return 'Report verified — displayed on live map'
    case 'amber': return 'Flagged for review — displayed with caution marker'
    case 'red': return 'Held for human review — not displayed on public map'
  }
}

/**
 * Trust Score Engine — scores a new submission 0–100.
 *
 * Four components (weights per proposal spec):
 *   Image Integrity     0–40  C2PA / AI fingerprint / camera provenance
 *   Geospatial          0–30  GPS accuracy + area validation
 *   Cross-Report        0–20  Corroboration from nearby existing reports
 *   Metadata            0–10  Channel, landmark/district completeness
 *
 * TRL 4-5 implementation: uses available device signals.
 * TRL 6+ would add: live C2PA API, satellite damage probability map,
 * server-side AI authenticity detection.
 */
export function calculateTrustScore(params: {
  // Photo signals
  hasPhoto:     boolean
  photoSource:  'camera' | 'library' | null   // camera = direct capture (EXIF intact)
  hasC2PA:      boolean                        // cryptographic device signature present
  aiAuthentic:  boolean                        // false = AI-generation fingerprint detected
  // GPS signals
  hasGps:       boolean
  gpsAccuracy:  number                         // metres; lower is better
  isInArea:     boolean                        // within declared disaster area
  // Submission signals
  channel:      SubmissionChannel
  hasLandmark:  boolean                        // landmark text field filled
  hasDistrict:  boolean                        // district text field filled
  // Cross-report signals (optional — pass empty array when no data available)
  nearbyReportCount?:          number          // reports within ~500m radius
  nearbyMatchingDamageCount?:  number          // nearby reports with same damage level
}): TrustScoreBreakdown {
  const {
    hasPhoto, photoSource, hasC2PA, aiAuthentic,
    hasGps, gpsAccuracy, isInArea,
    channel, hasLandmark, hasDistrict,
  } = params
  // Defensive clamping: callers occasionally pass inconsistent counts
  // (e.g. matching > total when filtering happens upstream). Without this guard
  // the cross-report branch can award the "strong corroboration" tier even when
  // `nearbyReportCount` is 0, which is logically impossible.
  const nearbyReportCount = Math.max(0, params.nearbyReportCount ?? 0)
  const nearbyMatchingDamageCount = Math.max(
    0,
    Math.min(params.nearbyMatchingDamageCount ?? 0, nearbyReportCount),
  )

  // ── Image Integrity (0–40) ──────────────────────────────────────────────────
  // C2PA: cryptographic proof photo came from this device at this moment (TRL 9)
  // Camera direct: EXIF timestamp + GPS embed intact (TRL 5)
  // Library: photo may be old, recycled, or from another device (TRL 4)
  // AI detection: fingerprint analysis flags synthetic content (TRL 5 demo)
  let imageIntegrity = 0
  if (hasPhoto) {
    if (hasC2PA) {
      imageIntegrity = 38                           // cryptographic provenance — near-maximum
    } else if (photoSource === 'camera') {
      imageIntegrity = 26                           // direct capture, EXIF likely intact
      if (hasGps && gpsAccuracy <= 20) imageIntegrity += 4  // GPS-photo corroboration bonus
    } else if (photoSource === 'library') {
      // Lowered from 16 → 8 after demo feedback: a library upload could be
      // anything (old, recycled, repurposed from the internet, AI-generated
      // outside our fingerprint coverage). The Trust Score should not be
      // generous about it; the burden is on the reporter to take a fresh
      // camera photo if they want a high image-integrity component.
      imageIntegrity = 8
    } else {
      imageIntegrity = 6                            // WhatsApp / unknown (EXIF stripped) — also lowered to stay below library
    }
    if (!aiAuthentic) imageIntegrity = Math.max(0, imageIntegrity - 18)  // AI detected penalty
  }
  imageIntegrity = Math.min(40, imageIntegrity)

  // ── Geospatial Consistency (0–30) ──────────────────────────────────────────
  // Satellite damage probability cross-reference is TRL 6+.
  // At TRL 5: area containment check + GPS accuracy scoring.
  let geospatial = 0
  if (!isInArea) {
    geospatial = 2    // outside declared disaster area — suspicious but not impossible
  } else if (!hasGps) {
    geospatial = 8    // location manually set or approximated — low confidence
  } else {
    // GPS accuracy → confidence bands
    if      (gpsAccuracy <=   5) geospatial = 30
    else if (gpsAccuracy <=  10) geospatial = 28
    else if (gpsAccuracy <=  20) geospatial = 26
    else if (gpsAccuracy <=  50) geospatial = 24
    else if (gpsAccuracy <= 100) geospatial = 20
    else if (gpsAccuracy <= 200) geospatial = 16
    else                         geospatial = 12   // GPS fix but very inaccurate
  }

  // ── Cross-Report Validation (0–20) ────────────────────────────────────────
  // H3 spatial clustering: corroborate against reports in the same ~500m cell.
  // Full implementation (TRL 6): server-side cluster analysis.
  // TRL 5 demo: use count of nearby reports visible in the current session.
  let crossReport: number
  if (nearbyReportCount === 0) {
    crossReport = 12    // no data to validate against — neutral score
  } else if (nearbyMatchingDamageCount >= 3) {
    crossReport = 19    // strong independent corroboration — same damage level × 3+
  } else if (nearbyMatchingDamageCount >= 1) {
    crossReport = 16    // partial corroboration — at least one matching nearby report
  } else if (nearbyReportCount >= 3) {
    crossReport = 10    // nearby reports exist but different damage level — inconsistent
  } else {
    crossReport = 13    // some nearby context, insufficient to validate
  }

  // ── Submission Metadata (0–10) ────────────────────────────────────────────
  // Channel trust weights: PWA (pre-installed, identity-consistent) > browser > WhatsApp
  // Landmark/district completeness: reporter invested effort → more credible
  let metadata = 0
  if      (channel === 'pwa')      metadata += 4
  else if (channel === 'browser')  metadata += 3
  else                             metadata += 2   // whatsapp
  if (hasLandmark)  metadata += 3
  if (hasDistrict)  metadata += 2
  if (hasGps)       metadata += 1
  metadata = Math.min(10, metadata)

  const total = imageIntegrity + geospatial + crossReport + metadata

  return { imageIntegrity, geospatial, crossReport, metadata, total }
}

// Keep old name as alias so existing mock data generation doesn't break
export function calculateDemoTrustScore(params: {
  hasPhoto: boolean
  hasGps: boolean
  gpsAccuracy: number
  channel: SubmissionChannel
  isInArea?: boolean
  hasC2PA?: boolean
  aiAuthentic?: boolean
}): TrustScoreBreakdown {
  return calculateTrustScore({
    hasPhoto:    params.hasPhoto,
    photoSource: params.hasGps ? 'camera' : 'library',  // best guess for mock data
    hasC2PA:     params.hasC2PA ?? false,
    aiAuthentic: params.aiAuthentic ?? true,
    hasGps:      params.hasGps,
    gpsAccuracy: params.gpsAccuracy,
    isInArea:    params.isInArea ?? true,
    channel:     params.channel,
    hasLandmark: true,   // mock reports always have landmark
    hasDistrict: true,
  })
}
