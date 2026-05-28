import { useEffect, useRef, useState, useMemo } from 'react'
import maplibregl from 'maplibre-gl'
import { mockReports } from '../data/mockReports'
import { CMS } from '../config'
import type { DamageReport, TrustTier, DeploymentConfig, ReviewMap, FusedEvent, SourceType } from '../types'
import { tierColors, damageLevelLabel, infraTypeLabel, channelLabel } from '../utils/trustColors'
import { getTierLabel } from '../utils/trustScore'
import { isWithinArea } from '../utils/geo'
import { fetchVerifiedEvents } from '../services/verifiedEvents'

/**
 * Display metadata for the three webhook sources. Replaces the bare lowercase
 * keys ("gdacs" / "copernicus" / "reliefweb") that read as opaque codes to
 * anyone who hasn't memorised the proposal. The label is what shows on the
 * chip; the tooltip explains the source's mandate in one line.
 */
const VERIFIED_SOURCE_META: ReadonlyArray<{
  key: Exclude<SourceType, 'citizen'>
  label: string
  tooltip: string
}> = [
  { key: 'gdacs',      label: 'GDACS',      tooltip: 'GDACS — UN OCHA + EU JRC global alerts: earthquakes, tsunamis, cyclones, floods, volcanoes, droughts, wildfires.' },
  { key: 'usgs',       label: 'USGS',       tooltip: 'USGS — U.S. Geological Survey authoritative earthquake feed. Cross-validates GDACS seismic alerts.' },
  { key: 'reliefweb',  label: 'ReliefWeb',  tooltip: 'ReliefWeb — UN OCHA humanitarian situation reports.' },
  // Copernicus EMS removed as a source: it has no public API, so its entries
  // were a curated snapshot whose per-activation links did not resolve. GDACS
  // and ReliefWeb are real, live RSS feeds — keeping only them makes the
  // multi-source story fully verifiable. The 'copernicus' SourceType is kept
  // in the type/sprite maps for compatibility but no events are produced.
]

/**
 * Generate a 64×64 (rendered at 2x for retina crispness) rounded-square
 * badge sprite via HTML5 Canvas. The result feeds `map.addImage()` so the
 * verified-event symbol layer can use it as `icon-image`.
 *
 * Why a sprite instead of HTML markers: DOM markers position via
 * `transform: translate(...)` in a separate compositing layer from
 * MapLibre's WebGL basemap. The two re-render with slightly different
 * timing during zoom, producing visible drift. Symbol-layer icons render
 * directly inside the WebGL canvas — perfectly synchronised, zero drift.
 */
function makeBadgeSprite(letter: string, strokeColor: string, fused: boolean): ImageData {
  const SIZE = 64
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')!
  // Drop shadow underneath (slight)
  ctx.shadowColor = 'rgba(0,0,0,0.45)'
  ctx.shadowBlur = 6
  ctx.shadowOffsetY = 2
  // Rounded square fill (white) with coloured stroke
  const inset = 8                // leave room for shadow
  const r = 10                   // corner radius
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = strokeColor
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.moveTo(inset + r, inset)
  ctx.lineTo(SIZE - inset - r, inset)
  ctx.quadraticCurveTo(SIZE - inset, inset, SIZE - inset, inset + r)
  ctx.lineTo(SIZE - inset, SIZE - inset - r)
  ctx.quadraticCurveTo(SIZE - inset, SIZE - inset, SIZE - inset - r, SIZE - inset)
  ctx.lineTo(inset + r, SIZE - inset)
  ctx.quadraticCurveTo(inset, SIZE - inset, inset, SIZE - inset - r)
  ctx.lineTo(inset, inset + r)
  ctx.quadraticCurveTo(inset, inset, inset + r, inset)
  ctx.closePath()
  ctx.fill()
  ctx.shadowColor = 'transparent'   // stroke without re-shadowing
  ctx.stroke()
  // Source letter, centred
  ctx.fillStyle = strokeColor
  ctx.font = 'bold 32px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(letter, SIZE / 2, SIZE / 2 + 2)   // +2 visual centring
  // Fused indicator: a small filled dot in the top-right corner
  if (fused) {
    ctx.beginPath()
    ctx.arc(SIZE - inset - 2, inset + 2, 7, 0, Math.PI * 2)
    ctx.fillStyle = '#1d4ed8'
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
  }
  return ctx.getImageData(0, 0, SIZE, SIZE)
}

/** Sprite id used by the symbol layer's `icon-image` expression. */
function verifiedSpriteId(sourceType: string, fused: boolean): string {
  return `verified-${sourceType}-${fused ? 'fused' : 'single'}`
}

interface Props {
  config: DeploymentConfig
  submittedReports?: DamageReport[]
  newReportIds?: Set<string>
  reviewMap?: ReviewMap
  // CMS data owned by App.tsx — single polling source to prevent double-refresh white screen
  cmsReports?: DamageReport[] | null
  isCmsLoading?: boolean
  cmsFetchError?: string | null
  onRefresh?: () => void
  /** Called when user taps "Open Form" on a map-placed pin — navigates to ReporterView with coords */
  onMapReport?: (lat: number, lng: number) => void
  /** Navigate to Admin panel (PIN screen) — shown as "Staff Login" in the sidebar */
  onGoToAdmin?: () => void
}

export default function DashboardView({
  config,
  submittedReports = [],
  newReportIds = new Set(),
  reviewMap = {},
  cmsReports = null,
  isCmsLoading = false,
  cmsFetchError = null,
  onRefresh,
  onMapReport,
  onGoToAdmin,
}: Props) {
  const mapContainer       = useRef<HTMLDivElement>(null)
  const mapRef             = useRef<maplibregl.Map | null>(null)
  const filteredReportsRef = useRef<DamageReport[]>([])
  const hasAutoFocusedRef  = useRef(false)
  const touchStartY    = useRef(0)
  const mobileListRef  = useRef<HTMLDivElement>(null)

  const [selectedReport, setSelectedReport] = useState<DamageReport | null>(null)
  const [selectedVerified, setSelectedVerified] = useState<FusedEvent | null>(null)
  const [tierFilter,     setTierFilter]     = useState<TrustTier | 'all'>('all')
  // The Sort selector ('time' / 'score') and the Type (infra) filter were
  // both removed from the UI during the Demo-MVP minimisation pass. The sort
  // is now hard-coded to newest-first in filteredReports; the infra filter
  // logic was deleted entirely. Re-add either by reintroducing the state +
  // the UI chips — the data layer is unchanged.
  const [verifiedFilter, setVerifiedFilter] = useState<'show' | 'hide'>('show')
  /** Per-source toggles within the verified-events lane. */
  const [sourceFilter,   setSourceFilter]   = useState<Record<Exclude<SourceType, 'citizen'>, boolean>>({
    gdacs: true, usgs: true, copernicus: true, reliefweb: true,
  })
  const [verifiedEvents, setVerifiedEvents] = useState<FusedEvent[]>([])
  const [mapReady,       setMapReady]       = useState(false)
  const [mobileListOpen, setMobileListOpen] = useState(true)
  // Mobile overlay starts collapsed so the map gets the full screen on first
  // load — operators tap to expand only when they need the status / filters.
  const [statsOpen,      setStatsOpen]      = useState(false)
  /**
   * Active basemap. 'light' is the Google-Maps-style grey background that
   * makes pins pop (default — best pin clarity); 'satellite' is the dramatic
   * option that shows the actual disaster zone topology. Toggle button next
   * to the navigation control lets the operator flip with one tap.
   */
  const [basemap, setBasemap] = useState<'satellite' | 'light'>('light')
  /**
   * Demo MVP mode: by default the sidebar shows only the title + a compact
   * one-line status + the reports list. All filters (tier / sort / verified
   * sources / infra type) live under a single collapsible "Filters" header
   * that starts closed, so a first-time evaluator's eye lands on the map
   * and the report stream rather than on chip toolbars. Power users open
   * the section once and the choice sticks for the session.
   */
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [legendOpen,  setLegendOpen]  = useState(false)
  const [isPullRefreshing, setIsPullRefreshing] = useState(false)
  /** Coordinates of a map-click pin — shown as "Report here?" strip until dismissed */
  const [mapReportPin, setMapReportPin] = useState<{ lat: number; lng: number } | null>(null)

  // ── Data ──────────────────────────────────────────────────────────────────
  const baseReports = useMemo((): DamageReport[] => {
    if (CMS.enabled && cmsReports !== null) return cmsReports
    return mockReports
  }, [cmsReports])

  const allReports = useMemo(() => {
    const sessionIds = new Set(submittedReports.map(r => r.id))
    return [...submittedReports, ...baseReports.filter(r => !sessionIds.has(r.id))]
  }, [submittedReports, baseReports])

  const filteredAllReports = useMemo(
    () => allReports.filter(r => reviewMap[r.id] !== 'rejected'),
    [allReports, reviewMap]
  )

  /**
   * Cross-source augmentation: when a citizen report falls inside ~50 km of
   * a verified Copernicus EMS event, tag it with `crossSourceMatch` and
   * bump its `trustScore.crossReport` by +15 (capped at 20). The total
   * score and tier are recomputed so a report can promote into a higher
   * tier (e.g. amber → green) when its location is satellite-corroborated.
   *
   * Copernicus is the only source treated as a cross-validation signal —
   * its mapping coordinates are at incident-level precision (vs ReliefWeb's
   * country-level centroid). The boost only fires when the citizen report
   * is genuinely co-located with the satellite-mapped event.
   */
  const visibleReports = useMemo(() => {
    const COP_RADIUS_KM = 50
    const BOOST_POINTS  = 15
    const copernicusEvents = verifiedEvents.filter(e => e.sourceType === 'copernicus')
    if (copernicusEvents.length === 0) return filteredAllReports
    return filteredAllReports.map(r => {
      const match = copernicusEvents.find(e =>
        isWithinArea(r.lat, r.lng, e.lat, e.lng, COP_RADIUS_KM)
      )
      if (!match) return r
      const boostedCross = Math.min(20, r.trustScore.crossReport + BOOST_POINTS)
      const newTotal =
        r.trustScore.imageIntegrity +
        r.trustScore.geospatial +
        boostedCross +
        r.trustScore.metadata
      const newTier: TrustTier = newTotal >= 80 ? 'green' : newTotal >= 50 ? 'amber' : 'red'
      return {
        ...r,
        trustScore: { ...r.trustScore, crossReport: boostedCross, total: newTotal },
        tier: newTier,
        crossSourceMatch: {
          sourceType: match.sourceType as 'copernicus',
          eventId:    match.eventId,
          eventTitle: match.title,
          eventUrl:   match.url,
        },
      }
    })
  }, [filteredAllReports, verifiedEvents])

  const stats = useMemo(() => ({
    green: visibleReports.filter(r => r.tier === 'green').length,
    amber: visibleReports.filter(r => r.tier === 'amber').length,
    red:   visibleReports.filter(r => r.tier === 'red').length,
  }), [visibleReports])

  const tierFilters = useMemo(() => [
    { label: `All (${visibleReports.length})`, tier: 'all' as const },
    { label: `Green (${stats.green})`,         tier: 'green' as const },
    { label: `Amber (${stats.amber})`,         tier: 'amber' as const },
    { label: `Red (${stats.red})`,             tier: 'red' as const },
  ], [visibleReports.length, stats])

  // Sort + infra filter are now no-ops at the UI level (the chips were
  // removed in the Demo-MVP cut). Reports always sort by newest timestamp.
  const filteredReports = useMemo(() => {
    const base = tierFilter === 'all' ? visibleReports : visibleReports.filter(r => r.tier === tierFilter)
    return [...base].sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    )
  }, [visibleReports, tierFilter])

  /**
   * Number of filters that have been changed from their default. The Sort
   * selector and Type (infra) filter were removed from the UI in the
   * Demo-MVP minimisation pass; their underlying state stays at the
   * defaults so we no longer count them here. */
  const activeFilterCount = useMemo(() => {
    let n = 0
    if (tierFilter !== 'all') n += 1
    if (verifiedFilter !== 'show') n += 1
    else {
      // each per-source chip that's been turned off counts as one active filter
      for (const k of ['gdacs', 'usgs', 'copernicus', 'reliefweb'] as const) {
        if (!sourceFilter[k]) n += 1
      }
    }
    return n
  }, [tierFilter, verifiedFilter, sourceFilter])

  // Keep ref in sync so map click handlers always see the current list
  filteredReportsRef.current = filteredReports

  /**
   * Zoom the map to fit all currently-visible verified events. Verified
   * events are global (most live outside the citizen reporting area), so
   * the default deployment-config bounds — tuned for Bangkok — leaves most
   * of them off-screen. Clicking the "verified" pill in the status row
   * runs this so the operator can survey the public-feed lane in one tap.
   */
  const fitMapToVerified = () => {
    const map = mapRef.current
    if (!map || visibleVerifiedEvents.length === 0) return
    const lngs = visibleVerifiedEvents.map(e => e.lng)
    const lats = visibleVerifiedEvents.map(e => e.lat)
    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 60, maxZoom: 6, duration: 800 },
    )
  }

  // ── Verified (webhook) events ─────────────────────────────────────────────
  // Fetched once on mount; refreshed manually via the refresh button so the
  // panel doesn't churn during normal use.
  useEffect(() => {
    let cancelled = false
    fetchVerifiedEvents().then(events => {
      if (!cancelled) setVerifiedEvents(events)
    })
    return () => { cancelled = true }
  }, [])

  /** Verified events visible after source-toggle filtering.
   *  Webhook sources are global by design — we deliberately do NOT scope
   *  these to the deployment area, so an operator viewing the Bangkok
   *  demo can still zoom out to see global disaster context. */
  const visibleVerifiedEvents = useMemo(() => {
    if (verifiedFilter !== 'show') return [] as FusedEvent[]
    return verifiedEvents.filter(e => {
      const enabled = sourceFilter[e.sourceType as Exclude<SourceType, 'citizen'>] ?? false
      return enabled
    })
  }, [verifiedFilter, sourceFilter, verifiedEvents])

  /** Ref so the map click handler always reads the current list without re-binding. */
  const verifiedRef = useRef<FusedEvent[]>([])
  verifiedRef.current = visibleVerifiedEvents

  const isLoading = CMS.enabled && isCmsLoading && cmsReports === null

  const dmgLabel = useMemo(() => ({
    minimal:   config.label_damage_minimal   ?? damageLevelLabel.minimal,
    partial:   config.label_damage_partial   ?? damageLevelLabel.partial,
    destroyed: config.label_damage_destroyed ?? damageLevelLabel.destroyed,
  }), [config])

  // Pull-to-refresh for mobile list
  useEffect(() => {
    const el = mobileListRef.current
    if (!el || !onRefresh) return
    const onStart = (e: TouchEvent) => { touchStartY.current = e.touches[0].clientY }
    const onEnd   = (e: TouchEvent) => {
      const dy = e.changedTouches[0].clientY - touchStartY.current
      if (dy > 64 && el.scrollTop <= 0) {
        setIsPullRefreshing(true)
        onRefresh()
        setTimeout(() => setIsPullRefreshing(false), 1500)
      }
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchend',   onEnd,   { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchend',   onEnd)
    }
  }, [onRefresh]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Map init ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return
    const bounds: maplibregl.LngLatBoundsLike = [
      [config.bounds_sw_lng, config.bounds_sw_lat],
      [config.bounds_ne_lng, config.bounds_ne_lat],
    ]
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        // Two basemap sources are defined at init time so the user can flip
        // between them via the floating button in the corner without our
        // having to swap the entire style (which would wipe the citizen and
        // verified data layers). We just toggle each basemap layer's
        // visibility — see the `basemap` state hook + matching useEffect.
        sources: {
          'esri-satellite': {
            type: 'raster',
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics',
            maxzoom: 18,
          },
          'carto-light': {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
              'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
              'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
            ],
            tileSize: 256,
            attribution: '© <a href="https://carto.com/">CARTO</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
            maxzoom: 19,
          },
        },
        layers: [
          // Both basemaps are attached at init time; visibility is toggled
          // via setLayoutProperty. Light is the default — pins read better
          // against grey than against the busy satellite imagery.
          { id: 'esri-satellite',  type: 'raster', source: 'esri-satellite',  layout: { visibility: 'none' } },
          { id: 'carto-light',     type: 'raster', source: 'carto-light',     layout: { visibility: 'visible' } },
        ],
      },
      bounds,
      fitBoundsOptions: { padding: 40 },
    })
    map.addControl(new maplibregl.NavigationControl(), 'top-right')
    mapRef.current = map
    map.on('load', () => {
      setMapReady(true)
      // Crosshair hints to the user that clicking an empty area places a report pin
      map.getCanvas().style.cursor = 'crosshair'
    })
    return () => { map.remove(); mapRef.current = null }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Flip basemap visibility when the user toggles the button. Both layers are
  // already attached at init time so we only swap layout.visibility — keeps
  // every overlay (citizen pins, verified markers, halos) intact across flips.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    map.setLayoutProperty('esri-satellite', 'visibility', basemap === 'satellite' ? 'visible' : 'none')
    map.setLayoutProperty('carto-light',    'visibility', basemap === 'light'     ? 'visible' : 'none')
    // Citizen-pin white halo helps against satellite but actively muddies the
    // pin on the light basemap, so we toggle it in lockstep with the basemap.
    if (map.getLayer('points-halo')) {
      map.setLayoutProperty('points-halo', 'visibility', basemap === 'satellite' ? 'visible' : 'none')
    }
  }, [basemap, mapReady])

  // Re-fit bounds when config changes
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    map.fitBounds(
      [[config.bounds_sw_lng, config.bounds_sw_lat], [config.bounds_ne_lng, config.bounds_ne_lat]],
      { padding: 40, duration: 800 }
    )
  }, [config, mapReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-focus newest submitted report once when map first becomes ready
  useEffect(() => {
    if (!mapReady || !mapRef.current || hasAutoFocusedRef.current) return
    if (newReportIds.size === 0) return
    const report = allReports.find(r => newReportIds.has(r.id))
    if (!report) return
    hasAutoFocusedRef.current = true
    setTimeout(() => {
      mapRef.current?.flyTo({ center: [report.lng, report.lat], zoom: 15 })
      setSelectedReport(report)
    }, 400)
  }, [mapReady, allReports]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── GeoJSON source + cluster layers ──────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return

    const features = filteredReports.map(report => ({
      type: 'Feature' as const,
      properties: {
        id:     report.id,
        color:  tierColors[report.tier].hex,
        status: reviewMap[report.id] === 'approved' ? 'approved' : 'pending',
      },
      geometry: { type: 'Point' as const, coordinates: [report.lng, report.lat] },
    }))
    const geojson = { type: 'FeatureCollection' as const, features }

    // Update-only path — source already exists
    const src = map.getSource('reports') as maplibregl.GeoJSONSource | undefined
    if (src) { src.setData(geojson); return }

    // First-time setup: source + layers + event handlers.
    //
    // Clustering is disabled by design — the typical demo scope is a single
    // city with ~30 citizen reports, so clusters mostly hide signal and the
    // user reported pins "disappearing" at lower zoom levels (they were
    // collapsing into a single 28-count cluster). The cluster aggregation
    // can be reintroduced for large-scale deployments later; for now every
    // pin always renders individually for visual clarity.
    map.addSource('reports', {
      type: 'geojson', data: geojson,
    })

    // White halo underneath citizen pins — improves contrast against the
    // satellite basemap (mixed greens/greys) without changing the meaningful
    // tier-colour signal carried by the foreground pin.
    map.addLayer({
      id: 'points-halo', type: 'circle', source: 'reports',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': '#ffffff',
        'circle-radius': 13,
        'circle-opacity': 0.55,
        'circle-blur': 0.35,
      },
    })

    map.addLayer({
      id: 'points', type: 'circle', source: 'reports',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': ['case', ['==', ['get', 'status'], 'approved'], ['get', 'color'], 'rgba(255,255,255,0.08)'],
        'circle-radius': 10,
        'circle-stroke-width': ['case', ['==', ['get', 'status'], 'approved'], 2.5, 2],
        'circle-stroke-color': ['get', 'color'],
        'circle-opacity': ['case', ['==', ['get', 'status'], 'pending'], 0.6, 1.0],
        'circle-stroke-opacity': ['case', ['==', ['get', 'status'], 'pending'], 0.75, 1.0],
      },
    })

    // ── Tap / click via native PointerEvents ────────────────────────────
    // MapLibre v4 uses PointerEvents internally. map.on('touchend') carries
    // a PointerEvent as originalEvent (changedTouches is undefined), so the
    // previous touchend approach silently failed on Android Chrome.
    //
    // Solution: attach pointerdown/pointerup directly to the canvas element.
    // These fire reliably for both touch (pointerType='touch') and mouse on
    // all modern browsers.  A 50 ms setTimeout lets MapLibre's synchronous
    // layer-click handlers set layerConsumed before we decide to place a pin.
    const canvas = map.getCanvas()
    let ptrStartX = 0, ptrStartY = 0

    const onPtrDown = (e: PointerEvent) => {
      ptrStartX = e.clientX
      ptrStartY = e.clientY
    }
    // All tap/click routing happens synchronously here, hit-testing the WebGL
    // layers via queryRenderedFeatures on the native PointerEvent. This is the
    // reliable path for touch on Android Chrome, where MapLibre's own
    // layer-click on a *symbol* layer (verified events) was not firing — so
    // webhook pins (GDACS etc.) could not be opened on mobile. Order: verified
    // symbols first (rendered on top), then citizen points, else drop a pin.
    const onPtrUp = (e: PointerEvent) => {
      const dx = e.clientX - ptrStartX
      const dy = e.clientY - ptrStartY
      // 15 px tolerance for touch (fingers move even on a "stationary" tap);
      // 5 px for mouse pointer.
      const tol = e.pointerType === 'touch' ? 225 : 25
      if (dx * dx + dy * dy > tol) return   // was a drag / pan
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      // Forgiving hit box for fingers; tight for the mouse pointer.
      const pad = e.pointerType === 'touch' ? 14 : 3
      const box: [[number, number], [number, number]] =
        [[x - pad, y - pad], [x + pad, y + pad]]

      // 1) Verified webhook symbols (rendered on top of the citizen points)
      if (map.getLayer('verified-symbols')) {
        const vf = map.queryRenderedFeatures(box, { layers: ['verified-symbols'] })
        if (vf.length) {
          const id = vf[0].properties?.id as string
          const event = verifiedRef.current.find(v => v.eventId === id)
          if (event) {
            setSelectedVerified(event)
            setSelectedReport(null)
            setMobileListOpen(false)
            setMapReportPin(null)
            return
          }
        }
      }

      // 2) Citizen report points
      if (map.getLayer('points')) {
        const pf = map.queryRenderedFeatures(box, { layers: ['points'] })
        if (pf.length) {
          const id = pf[0].properties?.id as string
          const report = filteredReportsRef.current.find(r => r.id === id)
          if (report) {
            setSelectedReport(report)
            setSelectedVerified(null)
            setMobileListOpen(false)
            setMapReportPin(null)
            return
          }
        }
      }

      // 3) Empty map → drop a new-report pin
      const lngLat = map.unproject([x, y])
      setMapReportPin({ lat: lngLat.lat, lng: lngLat.lng })
      setSelectedReport(null)
      setSelectedVerified(null)
      setMobileListOpen(false)
    }
    canvas.addEventListener('pointerdown', onPtrDown)
    canvas.addEventListener('pointerup',   onPtrUp)

    map.on('mouseenter', 'points', () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', 'points', () => { map.getCanvas().style.cursor = 'crosshair' })
    // Verified events use HTML markers (see the next useEffect) — their click
    // handlers fire on the DOM element directly, so no layer-click wiring here.
  }, [filteredReports, mapReady, reviewMap]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Verified-events symbol layer ─────────────────────────────────────────
  // Migrated from HTML maplibregl.Marker → a WebGL symbol layer in commit
  // following this comment. DOM markers were drifting during zoom because
  // they composite separately from the WebGL basemap. Symbol-layer icons
  // render inside the same canvas as the tiles, so they cannot desync.
  //
  // Sprites are generated programmatically via HTML5 Canvas (see
  // `makeBadgeSprite`) on map load and registered with `map.addImage`. We
  // ship two variants per source (single / fused), six sprites total, all
  // 64×64 px and uploaded as `pixelRatio: 2` for crispness on retina.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return

    // Per-source brand stroke colour, matching the SourceHero banner.
    const SOURCE_COLORS: Record<Exclude<SourceType, 'citizen'>, string> = {
      gdacs:      '#1d4ed8',
      usgs:       '#7c3aed',  // violet-600 — distinct from GDACS blue
      copernicus: '#047857',  // emerald-700
      reliefweb:  '#c2410c',  // orange-700
    }
    const LETTERS: Record<Exclude<SourceType, 'citizen'>, string> = {
      gdacs: 'G', usgs: 'U', copernicus: 'C', reliefweb: 'R',
    }

    // Register sprites if not already there. Re-registering is allowed (it
    // updates the existing image), so this is safe to run on every effect.
    for (const sourceType of ['gdacs', 'usgs', 'copernicus', 'reliefweb'] as const) {
      const color = SOURCE_COLORS[sourceType]
      const letter = LETTERS[sourceType]
      for (const fused of [false, true]) {
        const id = verifiedSpriteId(sourceType, fused)
        const data = makeBadgeSprite(letter, color, fused)
        if (map.hasImage(id)) map.removeImage(id)
        map.addImage(id, data, { pixelRatio: 2 })
      }
    }

    const features = visibleVerifiedEvents.map(event => ({
      type: 'Feature' as const,
      properties: {
        id:          event.eventId,
        sourceType:  event.sourceType,
        spriteId:    verifiedSpriteId(event.sourceType, event.sourceCount >= 2),
      },
      geometry: { type: 'Point' as const, coordinates: [event.lng, event.lat] },
    }))
    const geojson = { type: 'FeatureCollection' as const, features }

    const existing = map.getSource('verified') as maplibregl.GeoJSONSource | undefined
    if (existing) {
      existing.setData(geojson)
    } else {
      map.addSource('verified', { type: 'geojson', data: geojson })
      map.addLayer({
        id: 'verified-symbols',
        type: 'symbol',
        source: 'verified',
        layout: {
          'icon-image':            ['get', 'spriteId'],
          // Sprite is a 64px canvas registered at pixelRatio 2 → 32px logical.
          // icon-size 1.0 renders the full sprite at 32px; the badge inside
          // (≈48/64 of the canvas, the rest is shadow padding) lands at ≈24px
          // on screen — comparable to the citizen circles (20px diameter) so
          // the two lanes read at the same visual weight.
          'icon-size':             1.0,
          'icon-allow-overlap':    true,
          'icon-ignore-placement': true,
          'icon-anchor':           'center',
        },
      })
      map.on('mouseenter', 'verified-symbols', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'verified-symbols', () => { map.getCanvas().style.cursor = 'crosshair' })
      // Tap/click on a verified symbol is handled in the canvas pointerup
      // handler (see the points-layer effect), which hit-tests this layer via
      // queryRenderedFeatures. MapLibre's own symbol-layer click did not fire
      // for touch on Android Chrome, so webhook pins were unopenable on mobile.
    }
  }, [visibleVerifiedEvents, mapReady])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col lg:flex-row" style={{ minHeight: 0 }}>

      {/* ════════════ DESKTOP SIDEBAR ════════════════════════════════════════ */}
      <div className="hidden lg:flex lg:w-80 bg-white border-r border-gray-200 flex-col overflow-hidden">
        <div className="p-3 border-b border-gray-100">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-gray-700">{config.title}</h2>
            <div className="flex items-center gap-1.5">
              {/* CmsBadge ("● CMS") removed in the Demo-MVP minimisation pass —
                  internal connection state that meant nothing to evaluators.
                  Refresh button alone is enough; its loading spinner still
                  conveys "we're talking to the backend" when needed. */}
              {CMS.enabled && (
                <button onClick={onRefresh} title="Refresh report list" disabled={isCmsLoading}
                  className="text-gray-400 hover:text-blue-600 transition-colors p-0.5 disabled:opacity-50">
                  <svg xmlns="http://www.w3.org/2000/svg" className={`w-4 h-4 ${isCmsLoading ? 'animate-spin text-blue-500' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          {!CMS.enabled && (
            <div className="mb-2 text-[10px] bg-amber-50 border border-amber-200 rounded px-2 py-1 text-amber-700">⚠ Demo mode — not connected to Re:Earth CMS</div>
          )}
          {submittedReports.length > 0 && (
            <div className="mb-2 text-xs bg-green-50 border border-green-200 rounded px-2 py-1 text-green-700">
              +{submittedReports.length} report{submittedReports.length > 1 ? 's' : ''} this session
            </div>
          )}
          {cmsFetchError && <div className="mb-2 text-xs bg-red-50 border border-red-200 rounded px-2 py-1 text-red-600">{cmsFetchError} — showing demo data</div>}
          {/* Compact status pill — replaces the 3-box stats grid. Three
              tier-coloured dots with counts + the verified-events total. */}
          <div className="flex items-center gap-2.5 text-xs text-gray-600">
            {isLoading ? (
              <span className="text-gray-300">loading…</span>
            ) : (
              <>
                {(['green','amber','red'] as TrustTier[]).map(t => (
                  <span key={t} className="flex items-center gap-1" title={getTierLabel(t)}>
                    <span className="w-2 h-2 rounded-full" style={{backgroundColor: tierColors[t].hex}}/>
                    <span className="font-semibold text-gray-700">{stats[t]}</span>
                  </span>
                ))}
                <span className="text-gray-300">|</span>
                {/* Clickable "verified" pill — zooms the map out to fit ALL
                    verified events worldwide. The default Bangkok view shows
                    the citizen reports but most webhook events are in other
                    countries (Antigua earthquake, Mayon volcano, Mongolia
                    wildfires…). One tap → see them all. */}
                <button
                  onClick={fitMapToVerified}
                  disabled={visibleVerifiedEvents.length === 0}
                  title={visibleVerifiedEvents.length === 0
                    ? 'No verified events to show'
                    : `Click to fit map to all ${visibleVerifiedEvents.length} verified events worldwide`}
                  className="flex items-center gap-1 px-1.5 py-0.5 -mx-1.5 rounded hover:bg-gray-100 active:bg-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span className="w-2 h-2 rounded-sm border-[1.5px] border-blue-600"/>
                  <span className="font-semibold text-gray-700">{visibleVerifiedEvents.length}</span>
                  <span className="text-gray-400">verified</span>
                  {visibleVerifiedEvents.length > 0 && <span className="text-blue-500 text-[10px]">view ↗</span>}
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── Filters (single collapsible wrapper) ──────────────────────────
            Default state: closed. One header line shows the count of active
            filters next to a ▸/▾ chevron, so an unconfigured panel reads as
            "Filters" only (no visual weight) and the evaluator's eye goes
            straight to the map + the report stream. A power user opens it
            once and the toggle sticks for the session. */}
        <div className="border-b border-gray-100">
          <button
            onClick={() => setFiltersOpen(o => !o)}
            className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-50 transition-colors"
            aria-expanded={filtersOpen}
            title="Open to filter the report list by trust tier, source, or infrastructure type"
          >
            <span className="flex items-center gap-1.5 text-[11px] text-gray-500 font-medium">
              <span aria-hidden="true" className="text-gray-400">{filtersOpen ? '▾' : '▸'}</span>
              Filters
              {activeFilterCount > 0 && (
                <span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded-full font-semibold">
                  {activeFilterCount} active
                </span>
              )}
            </span>
            {!filtersOpen && tierFilter !== 'all' && (
              <span className="text-[10px] text-gray-400">{tierFilter}</span>
            )}
          </button>

          {filtersOpen && (
            <div className="px-3 pb-3 space-y-3">
              {/* Tier */}
              <div className="space-y-1">
                <div className="text-[10px] text-gray-400 uppercase tracking-wider">Tier</div>
                <div className="flex gap-1 flex-wrap">
                  {tierFilters.map(f => (
                    <button key={f.tier} onClick={() => setTierFilter(f.tier)}
                      className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                        tierFilter === f.tier
                          ? f.tier==='all' ? 'bg-gray-700 text-white' : f.tier==='green' ? 'bg-green-600 text-white' : f.tier==='amber' ? 'bg-amber-500 text-white' : 'bg-red-600 text-white'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}>{f.label}</button>
                  ))}
                </div>
              </div>

              {/* Verified Sources — labels expanded from bare lowercase keys
                  to proper source names + per-chip tooltips so an evaluator
                  doesn't have to know what "gdacs" stands for to use the
                  filter. The subtitle under the header gives the why in one
                  line: public disaster feeds that surface official alerts
                  before citizens can file reports. */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] text-gray-400 uppercase tracking-wider">Verified Sources</div>
                  <button
                    onClick={() => setVerifiedFilter(verifiedFilter === 'show' ? 'hide' : 'show')}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                      verifiedFilter === 'show' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                    }`}
                    title={verifiedFilter === 'show' ? 'Hide all webhook-sourced events from the map' : 'Show webhook-sourced events on the map'}
                  >
                    {verifiedFilter === 'show' ? 'On' : 'Off'}
                  </button>
                </div>
                <p className="text-[10px] text-gray-400 leading-snug">
                  Public disaster feeds — fill the information gap before citizens can file reports.
                </p>
                {verifiedFilter === 'show' && (
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {VERIFIED_SOURCE_META.map(({ key, label, tooltip }) => (
                      <button
                        key={key}
                        onClick={() => setSourceFilter(prev => ({ ...prev, [key]: !prev[key] }))}
                        title={tooltip}
                        className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                          sourceFilter[key] ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                        }`}
                      >{label}</button>
                    ))}
                  </div>
                )}
              </div>

              {/* Sort selector + Type / infra filter were removed during the
                  Demo MVP minimisation pass — evaluators never use them and
                  they were the noisiest section in the panel. Tier + Verified
                  Sources cover the actual filtering needs. */}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? Array.from({length:6}).map((_,i) => (
            <div key={i} className="px-3 py-2.5 border-b border-gray-100 animate-pulse">
              <div className="flex items-start gap-2"><div className="w-3 h-3 rounded-full bg-gray-200 mt-0.5 shrink-0"/><div className="flex-1 space-y-1.5"><div className="h-3 bg-gray-200 rounded w-3/4"/><div className="h-2.5 bg-gray-100 rounded w-1/2"/></div></div>
            </div>
          )) : !isLoading && filteredReports.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full p-6 text-center gap-3">
              <div className="text-4xl">📭</div>
              <p className="text-sm font-semibold text-gray-600">
                {CMS.enabled ? 'No reports yet' : 'Demo data hidden by filters'}
              </p>
              <p className="text-xs text-gray-400">
                {CMS.enabled
                  ? 'Be the first to submit a damage report'
                  : 'Clear filters to see all demo reports'}
              </p>
            </div>
          ) : filteredReports.map(report => {
            const isNew     = newReportIds.has(report.id)
            const inArea    = isWithinArea(report.lat, report.lng, config.area_center_lat, config.area_center_lng, config.area_radius_km)
            const reviewed  = reviewMap[report.id]
            const isPending = !reviewed
            return (
              <button key={report.id} onClick={() => { setSelectedReport(report); mapRef.current?.flyTo({center:[report.lng,report.lat],zoom:14}) }}
                className={`w-full text-left px-3 py-2.5 border-b border-gray-100 hover:bg-gray-50 transition-colors ${selectedReport?.id===report.id?'bg-blue-50':isNew?'bg-green-50':reviewed==='approved'?'bg-green-50/40':''}`}>
                <div className="flex items-start gap-2">
                  <div className={`w-3 h-3 rounded-full mt-0.5 shrink-0 ${isPending ? 'border-2 border-dashed bg-transparent' : ''}`}
                    style={isPending ? {borderColor:tierColors[report.tier].hex} : {backgroundColor:tierColors[report.tier].hex}}/>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-semibold text-gray-800 truncate">{report.id} {isNew&&<span className="text-green-600">★ New</span>}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        {reviewed === 'approved' && <span className="text-[9px] font-bold text-green-600 bg-green-100 px-1 rounded">✓</span>}
                        {isPending && <span className="text-[9px] font-medium text-gray-400 bg-gray-100 px-1 rounded">Unverified</span>}
                        <span className="text-xs font-bold" style={{color:tierColors[report.tier].hex}}>{report.trustScore.total}</span>
                      </div>
                    </div>
                    <div className="text-xs text-gray-500 truncate">{report.district} · {dmgLabel[report.damageLevel]}</div>
                    <div className="text-xs text-gray-400 line-clamp-2 leading-snug">{report.landmark}</div>
                    <div className="text-[10px] text-gray-300 flex items-center gap-1.5">
                      <span>{formatDate(report.timestamp)}</span>
                      {!inArea && <span className="text-orange-400 font-medium">· ⚠ Outside area</span>}
                    </div>
                  </div>
                </div>
              </button>
            )
          })}
        </div>

        {/* Staff login — subtle footer for municipal / government officials */}
        {onGoToAdmin && (
          <div className="shrink-0 border-t border-gray-100 px-3 py-2">
            <button
              onClick={onGoToAdmin}
              className="w-full flex items-center gap-1.5 text-[11px] text-gray-400 hover:text-gray-600 transition-colors py-1 rounded hover:bg-gray-50">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
              </svg>
              Government / Municipal Staff Login
            </button>
          </div>
        )}
      </div>

      {/* ════════════ MAP ═════════════════════════════════════════════════════ */}
      <div className="flex-1 relative" style={{ minHeight: '400px', minWidth: 0 }}>
        <div ref={mapContainer} style={{position:'absolute',top:0,left:0,right:0,bottom:0,width:'100%',height:'100%'}}/>

        {/* ── Basemap toggle ── */}
        {/* Sits directly below the MapLibre NavigationControl group and
            mimics its styling (29×29 white square, 4-px radius, same shadow)
            so the four-button stack reads as one cohesive control. Clicking
            flips to the OPPOSITE basemap; the icon shows what you'll get. */}
        <button
          onClick={() => setBasemap(b => b === 'satellite' ? 'light' : 'satellite')}
          title={basemap === 'satellite' ? 'Switch to light basemap (clearer pins)' : 'Switch to satellite imagery'}
          aria-label="Toggle basemap"
          className="absolute right-2.5 z-10 w-[29px] h-[29px] flex items-center justify-center bg-white hover:bg-gray-50 active:bg-gray-100 border border-gray-200 rounded shadow text-base leading-none transition-colors"
          style={{ top: 'calc(0.625rem + 88px)' }}
        >
          <span aria-hidden="true">{basemap === 'satellite' ? '🗺' : '🛰'}</span>
        </button>

        {/* ── Mobile stats overlay ── */}
        <div className="lg:hidden absolute top-2 left-2 right-14 z-10 bg-white bg-opacity-95 rounded-xl shadow-md overflow-hidden">
          <button onClick={() => setStatsOpen(v => !v)}
            className="w-full flex items-center justify-between px-2.5 py-2 gap-1">
            <span className="text-xs font-semibold text-gray-700">{config.title}</span>
            <div className="flex items-center gap-1.5">
              {/* CmsBadge removed for the same reason as the desktop header. */}
              {CMS.enabled && (
                <button onClick={e => { e.stopPropagation(); onRefresh?.() }} title="Refresh" disabled={isCmsLoading}
                  className="text-gray-400 hover:text-blue-600 transition-colors p-0.5 disabled:opacity-50">
                  <svg xmlns="http://www.w3.org/2000/svg" className={`w-3.5 h-3.5 ${isCmsLoading ? 'animate-spin text-blue-500' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
              )}
              <svg xmlns="http://www.w3.org/2000/svg" className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${statsOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
              </svg>
            </div>
          </button>
          {statsOpen && (
            <div className="px-2.5 pb-2.5 space-y-2">
              {/* Compact status pill — same shape as the desktop sidebar so
                  the operator's mental model carries between devices. */}
              <div className="flex items-center gap-2 text-xs text-gray-600">
                {isLoading ? <span className="text-gray-300">loading…</span> : (
                  <>
                    {(['green','amber','red'] as TrustTier[]).map(t => (
                      <span key={t} className="flex items-center gap-1" title={getTierLabel(t)}>
                        <span className="w-2 h-2 rounded-full" style={{backgroundColor: tierColors[t].hex}}/>
                        <span className="font-semibold text-gray-700">{stats[t]}</span>
                      </span>
                    ))}
                    <span className="text-gray-300">|</span>
                    <button
                      onClick={fitMapToVerified}
                      disabled={visibleVerifiedEvents.length === 0}
                      title={visibleVerifiedEvents.length === 0 ? 'No verified events' : 'Fit map to all verified events worldwide'}
                      className="flex items-center gap-1 px-1.5 py-0.5 -mx-1.5 rounded hover:bg-gray-100 active:bg-gray-200 transition-colors disabled:opacity-50"
                    >
                      <span className="w-2 h-2 rounded-sm border-[1.5px] border-blue-600"/>
                      <span className="font-semibold text-gray-700">{visibleVerifiedEvents.length}</span>
                      <span className="text-gray-400">verified</span>
                      {visibleVerifiedEvents.length > 0 && <span className="text-blue-500 text-[10px]">view ↗</span>}
                    </button>
                  </>
                )}
              </div>

              {/* Filters wrapper — shares filtersOpen with the desktop sidebar
                  so a user who unfolded filters on a tablet then resized to
                  phone-width doesn't have to unfold again. */}
              <div>
                <button
                  onClick={() => setFiltersOpen(o => !o)}
                  className="w-full flex items-center justify-between py-1 -mx-1 px-1 hover:bg-gray-50 rounded transition-colors"
                  aria-expanded={filtersOpen}
                >
                  <span className="flex items-center gap-1.5 text-[11px] text-gray-500 font-medium">
                    <span aria-hidden="true" className="text-gray-400">{filtersOpen ? '▾' : '▸'}</span>
                    Filters
                    {activeFilterCount > 0 && (
                      <span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded-full font-semibold">
                        {activeFilterCount} active
                      </span>
                    )}
                  </span>
                </button>
                {filtersOpen && (
                  <div className="pt-2 space-y-2">
                    {/* Tier */}
                    <div className="flex gap-1 flex-wrap">
                      {tierFilters.map(f => (
                        <button key={f.tier} onClick={() => setTierFilter(f.tier)}
                          className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                            tierFilter === f.tier
                              ? f.tier==='all' ? 'bg-gray-700 text-white' : f.tier==='green' ? 'bg-green-600 text-white' : f.tier==='amber' ? 'bg-amber-500 text-white' : 'bg-red-600 text-white'
                              : 'bg-gray-100 text-gray-600'
                          }`}>{f.label}</button>
                      ))}
                    </div>
                    {/* Verified Sources On/Off + chips */}
                    <div className="flex items-center gap-1 flex-wrap">
                      <button
                        onClick={() => setVerifiedFilter(verifiedFilter === 'show' ? 'hide' : 'show')}
                        className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                          verifiedFilter === 'show' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'
                        }`}
                      >Verified {verifiedFilter === 'show' ? 'On' : 'Off'}</button>
                      {verifiedFilter === 'show' && VERIFIED_SOURCE_META.map(({ key, label, tooltip }) => (
                        <button
                          key={key}
                          onClick={() => setSourceFilter(prev => ({ ...prev, [key]: !prev[key] }))}
                          title={tooltip}
                          className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                            sourceFilter[key] ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'
                          }`}
                        >{label}</button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Mobile staff login — subtle link at bottom of stats overlay */}
              {onGoToAdmin && (
                <button
                  onClick={onGoToAdmin}
                  className="w-full flex items-center justify-center gap-1.5 text-[11px] text-gray-400 hover:text-gray-600 transition-colors py-1 rounded hover:bg-gray-50 border-t border-gray-100 pt-2">
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                  </svg>
                  Government / Municipal Staff Login
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── Desktop legend (collapsible popover) ── */}
        {/* The full legend lives behind a small ⓘ button so the map starts
            uncluttered for the InnoCentive evaluator. Click reveals the
            same Trust Score + Verified Sources reference that used to be
            always-visible. */}
        <div className="hidden lg:block absolute bottom-6 left-3 z-10">
          {!legendOpen ? (
            <button
              onClick={() => setLegendOpen(true)}
              title="Show map legend"
              aria-label="Show map legend"
              className="w-7 h-7 flex items-center justify-center bg-white hover:bg-gray-50 active:bg-gray-100 border border-gray-200 rounded shadow text-xs leading-none transition-colors text-gray-500 font-bold"
            >ⓘ</button>
          ) : (
            <div className="bg-white bg-opacity-95 rounded-lg shadow-md p-2 text-xs">
              <div className="flex items-center justify-between mb-1">
                <span className="font-semibold text-gray-700">Trust Score</span>
                <button
                  onClick={() => setLegendOpen(false)}
                  className="text-gray-400 hover:text-gray-600 text-sm leading-none -mt-0.5"
                  aria-label="Hide legend"
                >✕</button>
              </div>
              {(['green','amber','red'] as TrustTier[]).map(t => (
                <div key={t} className="flex items-center gap-1.5 py-0.5">
                  <div className="w-3 h-3 rounded-full" style={{backgroundColor:tierColors[t].hex}}/>
                  <span className="text-gray-600">{t==='green'?'≥80 High Trust':t==='amber'?'50–79 Review':'<50 Human Review'}</span>
                </div>
              ))}
              <div className="border-t border-gray-100 mt-1.5 pt-1.5 space-y-0.5">
                <div className="flex items-center gap-1.5 py-0.5">
                  <div className="w-3 h-3 rounded-full bg-white border-2 border-dashed border-gray-400"/>
                  <span className="text-gray-400">Unverified</span>
                </div>
                <div className="flex items-center gap-1.5 py-0.5">
                  <div className="w-3 h-3 rounded-full bg-green-500 border-2 border-white"/>
                  <span className="text-gray-600">Admin Verified</span>
                </div>
              </div>
              <div className="border-t border-gray-100 mt-1.5 pt-1.5 space-y-0.5">
                <div className="font-semibold text-gray-700 mb-1">Verified Sources</div>
                <div className="flex items-center gap-1.5 py-0.5">
                  <div className="w-4 h-4 rounded bg-white border-[2.5px] border-blue-600 flex items-center justify-center text-[8px] font-extrabold text-blue-600 leading-none">G</div>
                  <span className="text-gray-600">GDACS / Copernicus / ReliefWeb</span>
                </div>
                <div className="flex items-center gap-1.5 py-0.5">
                  <div className="relative w-4 h-4">
                    <div className="w-4 h-4 rounded bg-white border-[2.5px] border-blue-700"/>
                    <div className="absolute -top-1 -right-1 min-w-[10px] h-[10px] px-[2px] bg-blue-700 text-white border border-white rounded-full text-[7px] font-extrabold leading-[10px] text-center">2×</div>
                  </div>
                  <span className="text-gray-600">Cross-validated (≥2 sources)</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Desktop selected report popup ── */}
        {selectedReport && (
          <div className="hidden lg:block absolute top-3 right-3 bg-white rounded-xl shadow-lg w-64 overflow-hidden border border-gray-200 z-10">
            <div className={`px-3 py-2 flex items-center justify-between ${tierColors[selectedReport.tier].bg}`}>
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full text-white text-xs font-bold flex items-center justify-center" style={{backgroundColor:tierColors[selectedReport.tier].hex}}>
                  {selectedReport.trustScore.total}
                </div>
                <span className={`text-xs font-semibold ${tierColors[selectedReport.tier].text}`}>{selectedReport.id} · {getTierLabel(selectedReport.tier)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                {reviewMap[selectedReport.id] === 'approved'
                  ? <span className="text-[10px] font-bold text-green-700 bg-green-200 px-1.5 py-0.5 rounded-full">✓ Verified</span>
                  : <span className="text-[10px] font-medium text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">Unverified</span>
                }
                <button onClick={() => setSelectedReport(null)} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
              </div>
            </div>
            {selectedReport.imageUrl ? (
              <img src={selectedReport.imageUrl} alt="damage photo" className="w-full h-36 object-cover"
                onError={e => {
                  // Image load failed (broken URL, network, CMS asset purge) —
                  // hide the broken-image icon. The card below handles the
                  // photo-less case via the conditional rendering above, but
                  // here we already committed the <img>, so just blank it.
                  (e.target as HTMLImageElement).style.display='none'
                }}/>
            ) : (
              <DamageHero
                damageLevel={selectedReport.damageLevel}
                infraType={selectedReport.infraType}
                tier={selectedReport.tier}
              />
            )}
            <div className="p-3 space-y-1.5 text-xs">
              <InfoRow label="District" value={selectedReport.district}/>
              <InfoRow label="Time"     value={formatDate(selectedReport.timestamp)}/>
              <InfoRow label="Damage"   value={dmgLabel[selectedReport.damageLevel]}/>
              <InfoRow label="Type"     value={infraTypeLabel[selectedReport.infraType]}/>
              <InfoRow label="Channel"  value={channelLabel[selectedReport.channel]}/>
              <InfoRow label="C2PA"     value={selectedReport.hasC2PA?'Verified ✓':'Not available'}/>
              {/* Cross-source badge — visible when this citizen report falls
                  inside a Copernicus EMS satellite-mapped footprint. Makes
                  the multi-source fusion story concrete: not just "two
                  layers on a map" but "this specific report is corroborated
                  by an independent satellite source". */}
              {selectedReport.crossSourceMatch && (
                <div className="pt-1.5">
                  <a
                    href={selectedReport.crossSourceMatch.eventUrl}
                    target="_blank" rel="noopener noreferrer"
                    className="block px-2 py-1.5 rounded-md bg-blue-50 border border-blue-200 hover:bg-blue-100 transition-colors text-[10px]"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-blue-700 font-bold">✓ Cross-source confirmed</span>
                      <span className="text-blue-500">(+15 cross)</span>
                    </div>
                    <div className="text-blue-700 truncate font-medium">
                      Copernicus EMS · {selectedReport.crossSourceMatch.eventTitle}
                    </div>
                  </a>
                </div>
              )}
              <div className="pt-1 border-t border-gray-100"><p className="text-gray-500 italic break-words">{selectedReport.landmark}</p></div>
              <div className="pt-1 space-y-1">
                <MiniBar label="Image" value={selectedReport.trustScore.imageIntegrity} max={40} color={tierColors[selectedReport.tier].hex}/>
                <MiniBar label="Geo"   value={selectedReport.trustScore.geospatial}     max={30} color={tierColors[selectedReport.tier].hex}/>
                <MiniBar label="Cross" value={selectedReport.trustScore.crossReport}    max={20} color={tierColors[selectedReport.tier].hex}/>
                <MiniBar label="Meta"  value={selectedReport.trustScore.metadata}       max={10} color={tierColors[selectedReport.tier].hex}/>
              </div>
            </div>
          </div>
        )}

        {/* ── Desktop verified-event popup (lineage card) ── */}
        {selectedVerified && !selectedReport && (
          <div className="hidden lg:block absolute top-3 right-3 bg-white rounded-xl shadow-lg w-72 overflow-hidden border-2 border-blue-300 z-10">
            <div className="px-3 py-2 flex items-center justify-between bg-blue-50">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center shrink-0">
                  {selectedVerified.trustScore.total}
                </div>
                <span className="text-xs font-semibold text-blue-900 truncate">
                  {selectedVerified.sourceType.toUpperCase()} · {selectedVerified.hazardType}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {selectedVerified.isFused && (
                  <span className="text-[10px] font-bold text-blue-700 bg-blue-200 px-1.5 py-0.5 rounded-full">
                    {selectedVerified.sourceCount}× fused
                  </span>
                )}
                <button onClick={() => setSelectedVerified(null)} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
              </div>
            </div>
            <SourceHero
              sourceType={selectedVerified.sourceType}
              hazardType={selectedVerified.hazardType}
              url={selectedVerified.url}
            />
            <div className="p-3 space-y-1.5 text-xs">
              <div className="font-medium text-gray-700 leading-snug">{selectedVerified.title}</div>
              {selectedVerified.description && (
                <p className="text-[11px] text-gray-500 leading-relaxed break-words">{selectedVerified.description}</p>
              )}
              <InfoRow label="When"     value={formatDate(selectedVerified.occurredAt)} />
              <InfoRow label="Country"  value={selectedVerified.country ?? '—'} />
              {selectedVerified.severity && (
                <InfoRow label="Severity" value={selectedVerified.severity.toUpperCase()} />
              )}
              {/* Spatial-precision honesty badge — ReliefWeb only carries
                  ISO3 country codes in its public RSS, so we look up an
                  approximate country centroid. Mark that clearly rather
                  than pretending the coordinates are incident-level. */}
              {selectedVerified.sourceType === 'reliefweb' && (
                <div className="text-[10px] bg-amber-50 border border-amber-200 rounded px-2 py-1 text-amber-700">
                  ≈ Country-level precision — ReliefWeb publishes country, not coordinates.
                </div>
              )}
              <div className="pt-2 border-t border-gray-100">
                <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">Lineage — fused from</div>
                <ul className="space-y-1">
                  {selectedVerified.lineage.fusedFrom.map((f, i) => (
                    <li key={f.eventId + i} className="flex items-center justify-between gap-2">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 shrink-0">
                        {f.sourceType}
                      </span>
                      <span className="text-[10px] text-gray-400 font-mono truncate flex-1" title={f.eventId}>{f.eventId}</span>
                      {f.url && (
                        <a href={f.url} target="_blank" rel="noopener noreferrer"
                          className="text-[10px] text-blue-600 hover:text-blue-800 underline shrink-0"
                          title={`Open ${f.sourceType} source for ${f.eventId}`}
                        >view ↗</a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="pt-2 space-y-1">
                <MiniBar label="Source" value={selectedVerified.trustScore.sourceIntegrity} max={40} color="#1d4ed8"/>
                <MiniBar label="Geo"    value={selectedVerified.trustScore.geospatial}      max={30} color="#1d4ed8"/>
                <MiniBar label="Cross"  value={selectedVerified.trustScore.crossSource}     max={20} color="#1d4ed8"/>
                <MiniBar label="Meta"   value={selectedVerified.trustScore.metadata}        max={10} color="#1d4ed8"/>
              </div>
              {selectedVerified.url && (
                <a href={selectedVerified.url} target="_blank" rel="noopener noreferrer"
                  className="block text-center mt-2 px-3 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 active:bg-blue-800 transition-colors">
                  View original source ↗
                </a>
              )}
            </div>
          </div>
        )}

        {/* ── Map report pin strip — desktop card + mobile full-width ── */}
        {mapReportPin && !selectedReport && (
          <>
            {/* Desktop: floating card at bottom-left (replaces legend while active) */}
            <div className="hidden lg:flex absolute bottom-4 left-3 z-10 w-72 bg-white rounded-xl shadow-lg border border-blue-200 p-3 items-center gap-3">
              <div className="w-8 h-8 shrink-0 rounded-full bg-blue-50 border-2 border-blue-300 flex items-center justify-center text-sm select-none">📍</div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-gray-800">Report damage here?</div>
                <div className="text-[10px] text-gray-400 font-mono">
                  {mapReportPin.lat.toFixed(5)}, {mapReportPin.lng.toFixed(5)}
                </div>
              </div>
              {onMapReport && (
                <button
                  onClick={() => { onMapReport(mapReportPin.lat, mapReportPin.lng); setMapReportPin(null) }}
                  className="shrink-0 px-3 py-1.5 bg-blue-700 text-white text-xs font-bold rounded-lg hover:bg-blue-800 active:bg-blue-900 transition-colors">
                  Open Form
                </button>
              )}
              <button onClick={() => setMapReportPin(null)}
                className="shrink-0 w-6 h-6 flex items-center justify-center text-gray-300 hover:text-gray-600 text-sm">✕</button>
            </div>
            {/* Mobile: full-width strip at bottom */}
            <div className="lg:hidden absolute bottom-0 left-0 right-0 z-30 bg-white border-t-2 border-blue-300 shadow-2xl p-3 flex items-center gap-3">
              <div className="w-10 h-10 shrink-0 rounded-full bg-blue-50 border-2 border-blue-300 flex items-center justify-center text-lg select-none">📍</div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-gray-800">Report damage here?</div>
                <div className="text-xs text-gray-400 font-mono">
                  {mapReportPin.lat.toFixed(5)}, {mapReportPin.lng.toFixed(5)}
                </div>
              </div>
              {onMapReport && (
                <button
                  onClick={() => { onMapReport(mapReportPin.lat, mapReportPin.lng); setMapReportPin(null) }}
                  className="shrink-0 px-4 py-2.5 bg-blue-700 text-white text-sm font-bold rounded-xl active:bg-blue-900 transition-colors">
                  Open Form
                </button>
              )}
              <button onClick={() => setMapReportPin(null)}
                className="shrink-0 w-8 h-8 flex items-center justify-center text-gray-300 text-xl">✕</button>
            </div>
          </>
        )}

        {/* ── Mobile: report list bottom sheet ── */}
        {!selectedReport && !mapReportPin && (
          <div className="lg:hidden absolute bottom-0 left-0 right-0 z-20">
            <button onClick={() => setMobileListOpen(!mobileListOpen)}
              className="w-full h-12 bg-white border-t border-gray-200 rounded-t-2xl flex items-center justify-between px-4 shadow-lg">
              <span className="text-sm font-semibold text-gray-700">
                {isLoading ? 'Loading reports…' : `${filteredReports.length} report${filteredReports.length !== 1 ? 's' : ''}`}
              </span>
              <svg xmlns="http://www.w3.org/2000/svg" className={`w-5 h-5 text-gray-400 transition-transform duration-300 ${mobileListOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7"/>
              </svg>
            </button>
            <div ref={mobileListRef} className={`bg-white overflow-y-auto transition-all duration-300 ${mobileListOpen ? 'max-h-60' : 'max-h-0 overflow-hidden'}`}>
              {isPullRefreshing && (
                <div className="flex items-center justify-center gap-2 py-2 text-xs text-blue-600">
                  <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"/>
                  Refreshing…
                </div>
              )}
              {filteredReports.map(report => {
                const isNew    = newReportIds.has(report.id)
                const reviewed = reviewMap[report.id]
                return (
                  <button key={report.id}
                    onClick={() => { setSelectedReport(report); setMobileListOpen(false); mapRef.current?.flyTo({center:[report.lng,report.lat],zoom:14}) }}
                    className={`w-full text-left px-4 py-3 border-b border-gray-100 active:bg-gray-50 ${isNew?'bg-green-50':''}`}>
                    <div className="flex items-center gap-3">
                      <div className={`w-3 h-3 rounded-full shrink-0 ${!reviewed ? 'border-2 border-dashed bg-transparent' : ''}`}
                        style={!reviewed ? {borderColor:tierColors[report.tier].hex} : {backgroundColor:tierColors[report.tier].hex}}/>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-semibold text-gray-800">{report.id} {isNew&&<span className="text-green-600 text-xs">★ New</span>}</span>
                          <div className="flex items-center gap-1 ml-2 shrink-0">
                            {reviewed === 'approved' && <span className="text-[9px] font-bold text-green-600 bg-green-100 px-1 rounded">✓</span>}
                            {!reviewed && <span className="text-[9px] text-gray-400 bg-gray-100 px-1 rounded">Unverified</span>}
                            <span className="text-sm font-bold" style={{color:tierColors[report.tier].hex}}>{report.trustScore.total}</span>
                          </div>
                        </div>
                        <div className="text-xs text-gray-500 truncate">{report.district} · {dmgLabel[report.damageLevel]}</div>
                        <div className="text-[10px] text-gray-400">{formatDate(report.timestamp)}</div>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Mobile: selected report bottom sheet ── */}
        {selectedReport && (
          <div className="lg:hidden absolute bottom-0 left-0 right-0 z-30 bg-white rounded-t-2xl shadow-2xl overflow-hidden" style={{maxHeight:'72%'}}>
            <div className={`px-4 py-3 flex items-center justify-between ${tierColors[selectedReport.tier].bg}`}>
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full text-white text-sm font-bold flex items-center justify-center shrink-0"
                  style={{backgroundColor:tierColors[selectedReport.tier].hex}}>
                  {selectedReport.trustScore.total}
                </div>
                <div>
                  <div className={`text-sm font-bold ${tierColors[selectedReport.tier].text}`}>{getTierLabel(selectedReport.tier)}</div>
                  <div className={`text-xs ${tierColors[selectedReport.tier].text} opacity-70`}>{selectedReport.id}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {reviewMap[selectedReport.id] === 'approved'
                  ? <span className="text-[10px] font-bold text-green-700 bg-green-200 px-1.5 py-0.5 rounded-full">✓ Verified</span>
                  : <span className="text-[10px] font-medium text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">Unverified</span>
                }
                {/* Close: re-opens the list so user can switch reports without extra taps */}
                <button onClick={() => { setSelectedReport(null); setMobileListOpen(true) }}
                  className="w-8 h-8 rounded-full bg-white bg-opacity-40 flex items-center justify-center text-gray-600 text-sm">✕</button>
              </div>
            </div>
            <div className="overflow-y-auto" style={{maxHeight:'calc(72vh - 60px)'}}>
              {/* Parity with the desktop popup: when no photo URL is on the
                  report (typical for bootstrap-seeded rows), substitute the
                  emoji-based DamageHero so the bottom sheet never opens with
                  an empty top band. */}
              {selectedReport.imageUrl ? (
                <img src={selectedReport.imageUrl} alt="damage photo" className="w-full h-48 object-cover"
                  onError={e => { (e.target as HTMLImageElement).style.display='none' }}/>
              ) : (
                <DamageHero
                  damageLevel={selectedReport.damageLevel}
                  infraType={selectedReport.infraType}
                  tier={selectedReport.tier}
                />
              )}
              <div className="p-4 space-y-2 text-sm">
                <InfoRowLg label="District" value={selectedReport.district}/>
                <InfoRowLg label="Time"     value={formatDate(selectedReport.timestamp)}/>
                <InfoRowLg label="Damage"   value={dmgLabel[selectedReport.damageLevel]}/>
                <InfoRowLg label="Type"     value={infraTypeLabel[selectedReport.infraType]}/>
                <InfoRowLg label="Channel"  value={channelLabel[selectedReport.channel]}/>
                <InfoRowLg label="C2PA"     value={selectedReport.hasC2PA?'Verified ✓':'Not available'}/>
                {/* Mobile cross-source badge (parity with desktop popup). */}
                {selectedReport.crossSourceMatch && (
                  <a
                    href={selectedReport.crossSourceMatch.eventUrl}
                    target="_blank" rel="noopener noreferrer"
                    className="block px-3 py-2 rounded-lg bg-blue-50 border border-blue-200 active:bg-blue-100"
                  >
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-blue-700 font-bold">✓ Cross-source confirmed</span>
                      <span className="text-blue-500">+15 cross</span>
                    </div>
                    <div className="text-blue-700 text-xs font-medium truncate">
                      Copernicus EMS · {selectedReport.crossSourceMatch.eventTitle}
                    </div>
                  </a>
                )}
                <p className="text-gray-400 text-xs italic pt-1">{selectedReport.landmark}</p>
                <div className="pt-2 space-y-2 border-t border-gray-100">
                  <MiniBar label="Image" value={selectedReport.trustScore.imageIntegrity} max={40} color={tierColors[selectedReport.tier].hex}/>
                  <MiniBar label="Geo"   value={selectedReport.trustScore.geospatial}     max={30} color={tierColors[selectedReport.tier].hex}/>
                  <MiniBar label="Cross" value={selectedReport.trustScore.crossReport}    max={20} color={tierColors[selectedReport.tier].hex}/>
                  <MiniBar label="Meta"  value={selectedReport.trustScore.metadata}       max={10} color={tierColors[selectedReport.tier].hex}/>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Shared helpers ────────────────────────────────────────────────────────────

// CmsBadge was removed in the Demo-MVP minimisation pass — it surfaced an
// internal connection state ("● CMS") that meant nothing to evaluators.

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1">
      <span className="text-gray-400 w-14 shrink-0">{label}</span>
      <span className="text-gray-700 font-medium">{value}</span>
    </div>
  )
}

/**
 * Visual hero for citizen-report cards that don't have a photo (e.g. reports
 * seeded via the bootstrap script). Mirrors the layout of the real damage
 * photo, so cards with and without imageUrl feel structurally identical.
 */
function DamageHero({ damageLevel, infraType, tier }:
  { damageLevel: import('../types').DamageLevel; infraType: import('../types').InfraType; tier: import('../types').TrustTier }) {
  const damageIcon =
    damageLevel === 'destroyed' ? '🏚️'
    : damageLevel === 'partial' ? '🏠'
    : '📍'
  const infraIcon =
    infraType === 'residential' ? '🏘️'
    : infraType === 'commercial' ? '🏪'
    : infraType === 'government' ? '🏛️'
    : infraType === 'utility'   ? '⚡'
    : infraType === 'transport' ? '🛣️'
    : infraType === 'community' ? '🏟️'
    : infraType === 'public_space' ? '🌳'
    : '📦'
  const tint =
    tier === 'red'   ? 'from-red-100 to-red-50'
    : tier === 'amber' ? 'from-amber-100 to-amber-50'
    : 'from-emerald-100 to-emerald-50'
  return (
    <div className={`relative h-28 flex items-center justify-center gap-2 bg-gradient-to-br ${tint}`}>
      <span className="text-5xl" role="img" aria-hidden="true">{damageIcon}</span>
      <span className="text-3xl opacity-70" role="img" aria-hidden="true">{infraIcon}</span>
      <span className="absolute bottom-1.5 right-2 text-[10px] uppercase tracking-wider font-bold text-gray-500 bg-white bg-opacity-80 px-1.5 py-0.5 rounded">
        No photo
      </span>
    </div>
  )
}

/**
 * Visual hero for verified-event cards. Webhook sources don't carry photos
 * (they're machine-generated alerts), so we render a large hazard icon over
 * a severity-tinted band rather than leave the card photo-less.
 */
/**
 * Hero band for verified-event cards. Each webhook source gets its own
 * brand-coloured gradient so the operator can tell at a glance "this came
 * from GDACS" (vs. ReliefWeb / Copernicus / a citizen), with the hazard
 * icon as a secondary visual on the right. The whole banner is a link to
 * the original source — fetching live preview images per-event would be
 * unreliable, but linking back to the canonical page is always safe.
 *
 * Citizens keep the existing DamageHero in their own card so the two
 * categories never share a visual treatment.
 */
function SourceHero({ sourceType, hazardType, url }:
  { sourceType: SourceType
    hazardType: import('../types').HazardType
    url?: string
  }) {
  const theme =
    sourceType === 'gdacs'      ? { bg: 'from-blue-700 to-blue-900',      label: 'GDACS',          sublabel: 'UN OCHA + EU JRC' }
    : sourceType === 'usgs'       ? { bg: 'from-violet-600 to-violet-900', label: 'USGS',           sublabel: 'U.S. Geological Survey' }
    : sourceType === 'copernicus' ? { bg: 'from-emerald-700 to-blue-800', label: 'Copernicus EMS', sublabel: 'European Commission' }
    : sourceType === 'reliefweb'  ? { bg: 'from-orange-600 to-red-700',   label: 'ReliefWeb',      sublabel: 'UN OCHA' }
    : { bg: 'from-gray-600 to-gray-800', label: 'Source', sublabel: '' }
  const icon =
    hazardType === 'earthquake' ? '🌐'
    : hazardType === 'tsunami'  ? '🌊'
    : hazardType === 'cyclone'  ? '🌀'
    : hazardType === 'flood'    ? '💧'
    : hazardType === 'volcano'  ? '🌋'
    : hazardType === 'drought'  ? '🏜️'
    : hazardType === 'wildfire' ? '🔥'
    : '⚠️'
  const hazardLabel = hazardType.charAt(0).toUpperCase() + hazardType.slice(1)

  const content = (
    <div className={`relative h-28 px-4 flex items-center justify-between gap-3 bg-gradient-to-br ${theme.bg} text-white`}>
      <div className="min-w-0 flex-1">
        <div className="text-[9px] uppercase tracking-widest opacity-75 font-semibold">Verified Source</div>
        <div className="text-lg sm:text-xl font-extrabold leading-tight truncate">{theme.label}</div>
        <div className="text-[10px] opacity-80 truncate">{theme.sublabel}</div>
      </div>
      <div className="text-right shrink-0">
        <span className="text-4xl block leading-none" role="img" aria-label={hazardLabel}>{icon}</span>
        <span className="text-[10px] uppercase tracking-wider opacity-80 font-semibold">{hazardLabel}</span>
      </div>
      {url && (
        <span className="absolute bottom-1.5 right-2 text-[9px] opacity-70 font-medium">
          tap to view ↗
        </span>
      )}
    </div>
  )

  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" className="block hover:brightness-110 transition-all">
      {content}
    </a>
  ) : content
}

function InfoRowLg({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-gray-400 w-16 shrink-0 text-sm">{label}</span>
      <span className="text-gray-800 font-semibold text-sm">{value}</span>
    </div>
  )
}

function MiniBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-gray-400 w-10 shrink-0">{label}</span>
      <div className="flex-1 bg-gray-200 rounded-full h-2">
        <div className="h-2 rounded-full" style={{width:`${(value/max)*100}%`,backgroundColor:color}}/>
      </div>
      <span className="text-gray-500 w-10 text-right">{value}/{max}</span>
    </div>
  )
}

/** Locale-independent date formatter — avoids "Invalid Date" on mobile browsers */
function formatDate(iso: string): string {
  if (!iso) return '—'
  try {
    // Normalise common non-ISO formats returned by some CMS backends
    const normalized = iso
      .replace(' ', 'T')           // "2026-04-16 12:34" → "2026-04-16T12:34"
      .replace(' +0000 UTC', 'Z')  // Go time.RFC3339 suffix
      .replace(' UTC', 'Z')
    const d = new Date(normalized)
    if (isNaN(d.getTime())) return '—'
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${hh}:${mm}`
  } catch {
    return '—'
  }
}
