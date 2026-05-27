/**
 * Bangkok Flood scenario reference data — shared by seed and bootstrap scripts.
 *
 * The 28 damage reports mirror demo/src/data/mockReports.ts (the React app's
 * built-in fallback when CMS is empty). The deployment-config payload mirrors
 * cmsApi.ts DEFAULT_CONFIG. Keep these three in sync if you edit any of them.
 */

/**
 * Single source of truth for the deployment-config row that the React app
 * reads via fetchDeploymentConfig(). Mirrors DEFAULT_CONFIG in cmsApi.ts.
 */
export const BANGKOK_CONFIG = {
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
  description:     'Bangkok Flood Response — Don Mueang / Bang Sue (Chao Phraya Basin)',
  // English damage-level labels for the international UNDP submission. These
  // override the model defaults so the dashboard reads in English regardless
  // of the locale of any previous deployment-config row.
  label_damage_minimal:   'Minimal',
  label_damage_partial:   'Partially Damaged',
  label_damage_destroyed: 'Completely Destroyed',
  // Note: admin_pin / viewer_pin are intentionally NOT touched by the
  // bootstrap script. The existing PIN values in CMS are preserved.
}

/**
 * 28 Bangkok flood reports — extracted from demo/src/data/mockReports.ts.
 * Tier distribution: 10 green (≥80) / 11 amber (50–79) / 7 red (<50).
 */
export const BANGKOK_REPORTS = [
  // ── GREEN TIER ─────────────────────────────────────────────────────────────
  {
    damage_level: 'destroyed', infra_type: 'residential',
    landmark: 'Near Don Mueang Market, Soi Chaeng Watthana 10',
    district: 'Don Mueang', lat: 13.9125, lng: 100.5988,
    channel: 'pwa', has_c2pa: true, h3_cell: '8865b1b6dffffff',
    tier: 'green',
    trust_score_total: 93, trust_score_image: 38, trust_score_geo: 28, trust_score_cross: 18, trust_score_meta: 9,
  },
  {
    damage_level: 'partial', infra_type: 'community',
    landmark: 'Don Mueang Community Hall, adjacent to Klong Ban Mai',
    district: 'Don Mueang', lat: 13.9051, lng: 100.6102,
    channel: 'pwa', has_c2pa: false, h3_cell: '8865b1b6dffffff',
    tier: 'green',
    trust_score_total: 88, trust_score_image: 36, trust_score_geo: 27, trust_score_cross: 17, trust_score_meta: 8,
  },
  {
    damage_level: 'destroyed', infra_type: 'utility',
    landmark: 'Electrical substation, Vibhavadi Rangsit Rd km 8',
    district: 'Don Mueang', lat: 13.8956, lng: 100.5901,
    channel: 'pwa', has_c2pa: true, h3_cell: '8865b1b4bffffff',
    tier: 'green',
    trust_score_total: 91, trust_score_image: 37, trust_score_geo: 29, trust_score_cross: 16, trust_score_meta: 9,
  },
  {
    damage_level: 'partial', infra_type: 'transport',
    landmark: 'Flooding on expressway on-ramp, Don Mueang Tollway',
    district: 'Don Mueang', lat: 13.8801, lng: 100.5845,
    channel: 'browser', has_c2pa: false, h3_cell: '8865b1b0bffffff',
    tier: 'green',
    trust_score_total: 87, trust_score_image: 35, trust_score_geo: 26, trust_score_cross: 18, trust_score_meta: 8,
  },
  {
    damage_level: 'destroyed', infra_type: 'residential',
    landmark: 'Laksi Village Moo 3 — ground floor submerged 1.5m',
    district: 'Laksi', lat: 13.8620, lng: 100.5712,
    channel: 'pwa', has_c2pa: true, h3_cell: '8865b1a2bffffff',
    tier: 'green',
    trust_score_total: 92, trust_score_image: 38, trust_score_geo: 28, trust_score_cross: 17, trust_score_meta: 9,
  },
  {
    damage_level: 'partial', infra_type: 'government',
    landmark: 'Bang Khen District Office — basement flooded',
    district: 'Bang Khen', lat: 13.8488, lng: 100.5620,
    channel: 'browser', has_c2pa: false, h3_cell: '8865b1a09ffffff',
    tier: 'green',
    trust_score_total: 87, trust_score_image: 34, trust_score_geo: 27, trust_score_cross: 18, trust_score_meta: 8,
  },
  {
    damage_level: 'destroyed', infra_type: 'residential',
    landmark: 'Chatuchak housing estate Block C, near JJ Market',
    district: 'Chatuchak', lat: 13.8350, lng: 100.5540,
    channel: 'pwa', has_c2pa: true, h3_cell: '8865b18d7ffffff',
    tier: 'green',
    trust_score_total: 91, trust_score_image: 37, trust_score_geo: 28, trust_score_cross: 17, trust_score_meta: 9,
  },
  {
    damage_level: 'partial', infra_type: 'community',
    landmark: 'Chatuchak Park community shelter — overflow 80cm',
    district: 'Chatuchak', lat: 13.8215, lng: 100.5490,
    channel: 'pwa', has_c2pa: false, h3_cell: '8865b18d7ffffff',
    tier: 'green',
    trust_score_total: 88, trust_score_image: 35, trust_score_geo: 26, trust_score_cross: 18, trust_score_meta: 9,
  },
  {
    damage_level: 'destroyed', infra_type: 'residential',
    landmark: 'Pathum Thani Moo 5, Bang Phun subdistrict',
    district: 'Pathum Thani', lat: 14.0120, lng: 100.5870,
    channel: 'pwa', has_c2pa: true, h3_cell: '8865b1e4bffffff',
    tier: 'green',
    trust_score_total: 91, trust_score_image: 38, trust_score_geo: 27, trust_score_cross: 17, trust_score_meta: 9,
  },
  {
    damage_level: 'partial', infra_type: 'transport',
    landmark: 'Phahonyothin Road km 42, Pathum Thani — road cut off',
    district: 'Pathum Thani', lat: 14.0230, lng: 100.5760,
    channel: 'browser', has_c2pa: false, h3_cell: '8865b1e69ffffff',
    tier: 'green',
    trust_score_total: 86, trust_score_image: 33, trust_score_geo: 27, trust_score_cross: 18, trust_score_meta: 8,
  },

  // ── AMBER TIER ─────────────────────────────────────────────────────────────
  {
    damage_level: 'partial', infra_type: 'residential',
    landmark: 'Rangsit Klong 1 area, near Future Park mall',
    district: 'Pathum Thani', lat: 13.9310, lng: 100.6150,
    channel: 'whatsapp', has_c2pa: false, h3_cell: '8865b1e4bffffff',
    tier: 'amber',
    trust_score_total: 68, trust_score_image: 22, trust_score_geo: 24, trust_score_cross: 15, trust_score_meta: 7,
  },
  {
    damage_level: 'destroyed', infra_type: 'commercial',
    landmark: 'Shop row on Lam Luk Ka Road — unknown street number',
    district: 'Don Mueang', lat: 13.9180, lng: 100.6050,
    channel: 'whatsapp', has_c2pa: false, h3_cell: '8865b1b6dffffff',
    tier: 'amber',
    trust_score_total: 63, trust_score_image: 20, trust_score_geo: 23, trust_score_cross: 14, trust_score_meta: 6,
  },
  {
    damage_level: 'partial', infra_type: 'utility',
    landmark: 'Water treatment facility, Sai Mai area',
    district: 'Sai Mai', lat: 13.8770, lng: 100.5780,
    channel: 'browser', has_c2pa: false, h3_cell: '8865b1b0bffffff',
    tier: 'amber',
    trust_score_total: 66, trust_score_image: 25, trust_score_geo: 22, trust_score_cross: 12, trust_score_meta: 7,
  },
  {
    damage_level: 'minimal', infra_type: 'government',
    landmark: 'Laksi health clinic — road access blocked',
    district: 'Laksi', lat: 13.8630, lng: 100.5810,
    channel: 'whatsapp', has_c2pa: false, h3_cell: '8865b1a2bffffff',
    tier: 'amber',
    trust_score_total: 59, trust_score_image: 19, trust_score_geo: 21, trust_score_cross: 13, trust_score_meta: 6,
  },
  {
    damage_level: 'partial', infra_type: 'residential',
    landmark: 'Bang Khen alley housing, near MRT Sai Ma station',
    district: 'Bang Khen', lat: 13.8510, lng: 100.5680,
    channel: 'pwa', has_c2pa: false, h3_cell: '8865b1a09ffffff',
    tier: 'amber',
    trust_score_total: 67, trust_score_image: 26, trust_score_geo: 20, trust_score_cross: 14, trust_score_meta: 7,
  },
  {
    damage_level: 'destroyed', infra_type: 'transport',
    landmark: 'Chatuchak underpass — 1.8m flood depth',
    district: 'Chatuchak', lat: 13.8370, lng: 100.5610,
    channel: 'whatsapp', has_c2pa: false, h3_cell: '8865b18d7ffffff',
    tier: 'amber',
    trust_score_total: 62, trust_score_image: 21, trust_score_geo: 24, trust_score_cross: 11, trust_score_meta: 6,
  },
  {
    damage_level: 'partial', infra_type: 'community',
    landmark: 'Bang Sue Grand Station vicinity — track 12 flooded',
    district: 'Bang Sue', lat: 13.8100, lng: 100.5450,
    channel: 'browser', has_c2pa: false, h3_cell: '8865b18c3ffffff',
    tier: 'amber',
    trust_score_total: 69, trust_score_image: 24, trust_score_geo: 23, trust_score_cross: 15, trust_score_meta: 7,
  },
  {
    damage_level: 'minimal', infra_type: 'residential',
    landmark: 'Phra Nakhon old town near Khao San Road area',
    district: 'Phra Nakhon', lat: 13.7980, lng: 100.5380,
    channel: 'whatsapp', has_c2pa: false, h3_cell: '8865b1887ffffff',
    tier: 'amber',
    trust_score_total: 61, trust_score_image: 20, trust_score_geo: 22, trust_score_cross: 13, trust_score_meta: 6,
  },
  {
    damage_level: 'partial', infra_type: 'public_space',
    landmark: 'Sanam Luang — temporary shelter overwhelmed',
    district: 'Phra Nakhon', lat: 13.7850, lng: 100.5350,
    channel: 'browser', has_c2pa: false, h3_cell: '8865b1887ffffff',
    tier: 'amber',
    trust_score_total: 63, trust_score_image: 23, trust_score_geo: 21, trust_score_cross: 12, trust_score_meta: 7,
  },
  {
    damage_level: 'destroyed', infra_type: 'residential',
    landmark: 'Rangsit canal bank housing collapse',
    district: 'Pathum Thani', lat: 13.9450, lng: 100.5990,
    channel: 'whatsapp', has_c2pa: false, h3_cell: '8865b1e69ffffff',
    tier: 'amber',
    trust_score_total: 62, trust_score_image: 18, trust_score_geo: 23, trust_score_cross: 15, trust_score_meta: 6,
  },
  {
    damage_level: 'partial', infra_type: 'government',
    landmark: 'Pathum Thani Province Hall annex — 1F flooded',
    district: 'Pathum Thani', lat: 14.0050, lng: 100.5920,
    channel: 'browser', has_c2pa: false, h3_cell: '8865b1e4bffffff',
    tier: 'amber',
    trust_score_total: 68, trust_score_image: 22, trust_score_geo: 25, trust_score_cross: 14, trust_score_meta: 7,
  },

  // ── RED TIER ───────────────────────────────────────────────────────────────
  {
    damage_level: 'destroyed', infra_type: 'residential',
    landmark: 'Unspecified location — photo only, no GPS',
    district: 'Don Mueang', lat: 13.9005, lng: 100.6300,
    channel: 'whatsapp', has_c2pa: false, h3_cell: '8865b1b55ffffff',
    tier: 'red',
    trust_score_total: 33, trust_score_image: 8, trust_score_geo: 12, trust_score_cross: 10, trust_score_meta: 3,
  },
  {
    damage_level: 'destroyed', infra_type: 'commercial',
    landmark: 'Large shopping mall — image reverse-match flagged as 2011 flood',
    district: 'Don Mueang', lat: 13.8900, lng: 100.5700,
    channel: 'whatsapp', has_c2pa: false, h3_cell: '8865b1b4bffffff',
    tier: 'red',
    trust_score_total: 31, trust_score_image: 4, trust_score_geo: 14, trust_score_cross: 9, trust_score_meta: 4,
  },
  {
    damage_level: 'destroyed', infra_type: 'utility',
    landmark: 'Power station — AI-generation pattern detected in image',
    district: 'Laksi', lat: 13.8680, lng: 100.5900,
    channel: 'whatsapp', has_c2pa: false, h3_cell: '8865b1a2bffffff',
    tier: 'red',
    trust_score_total: 28, trust_score_image: 2, trust_score_geo: 15, trust_score_cross: 8, trust_score_meta: 3,
  },
  {
    damage_level: 'destroyed', infra_type: 'government',
    landmark: 'GPS coordinates place report in Chao Phraya River — location invalid',
    district: 'Bang Khen', lat: 13.8450, lng: 100.5500,
    channel: 'browser', has_c2pa: false, h3_cell: '8865b1a09ffffff',
    tier: 'red',
    trust_score_total: 32, trust_score_image: 15, trust_score_geo: 5, trust_score_cross: 8, trust_score_meta: 4,
  },
  {
    damage_level: 'destroyed', infra_type: 'transport',
    landmark: 'Duplicate submission — identical image hash as earlier report',
    district: 'Chatuchak', lat: 13.8280, lng: 100.5570,
    channel: 'whatsapp', has_c2pa: false, h3_cell: '8865b18d7ffffff',
    tier: 'red',
    trust_score_total: 31, trust_score_image: 5, trust_score_geo: 16, trust_score_cross: 6, trust_score_meta: 4,
  },
  {
    damage_level: 'destroyed', infra_type: 'residential',
    landmark: 'Mass submission from single device — 14 reports in 90 seconds',
    district: 'Bang Sue', lat: 13.7920, lng: 100.5480,
    channel: 'browser', has_c2pa: false, h3_cell: '8865b18c3ffffff',
    tier: 'red',
    trust_score_total: 30, trust_score_image: 10, trust_score_geo: 13, trust_score_cross: 5, trust_score_meta: 2,
  },
  {
    damage_level: 'destroyed', infra_type: 'residential',
    landmark: 'Coordinates outside known flood zone — geospatial inconsistency',
    district: 'Pathum Thani', lat: 14.0400, lng: 100.6100,
    channel: 'whatsapp', has_c2pa: false, h3_cell: '8865b1e69ffffff',
    tier: 'red',
    trust_score_total: 27, trust_score_image: 12, trust_score_geo: 4, trust_score_cross: 8, trust_score_meta: 3,
  },
]
