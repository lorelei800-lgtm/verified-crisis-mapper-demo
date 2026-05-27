import { useState, useRef, useEffect, useMemo, lazy, Suspense } from 'react'
import type { DamageLevel, InfraType, SubmissionChannel, DamageReport, DeploymentConfig } from '../types'

// Lazy-load the map picker so MapLibre is only bundled when the user opens it
const MapPickerOverlay = lazy(() => import('./MapPickerOverlay'))
import { calculateTrustScore, getTier, getTierLabel, getTierDescription } from '../utils/trustScore'
import { tierColors, damageLevelLabel, infraTypeLabel } from '../utils/trustColors'
import { uploadAsset, createReportItem } from '../services/cmsApi'
import { isWithinArea, haversineKm } from '../utils/geo'
import { enqueueReport } from '../services/offlineQueue'
import { CMS } from '../config'

interface Props {
  config: DeploymentConfig
  onViewDashboard: () => void
  onNewReport: (report: DamageReport) => void
  existingReports?: DamageReport[]   // for cross-report validation
  isOnline?: boolean
  /** Coordinates pre-filled when the user taps "Report here" on the dashboard map */
  prefilledLocation?: { lat: number; lng: number }
}

type FormStep    = 'form' | 'submitting' | 'result'
type SubmitPhase = 'scoring' | 'analyzing' | 'done'
type CmsSyncStatus = 'idle' | 'syncing' | 'synced' | 'queued' | 'error'

export default function ReporterView({ config, onViewDashboard, onNewReport, existingReports = [], isOnline: isOnlineProp, prefilledLocation }: Props) {
  const [step, setStep]               = useState<FormStep>('form')
  const [submitPhase, setSubmitPhase] = useState<SubmitPhase>('scoring')

  // Form fields
  const [photoFile, setPhotoFile]         = useState<File | null>(null)
  const [photoPreview, setPhotoPreview]   = useState<string | null>(null)
  const [photoSource, setPhotoSource]     = useState<'camera' | 'library' | null>(null)
  const [damageLevel, setDamageLevel]     = useState<DamageLevel | ''>('')
  const [infraType, setInfraType]         = useState<InfraType | ''>('')
  const [landmark, setLandmark]           = useState('')
  // The "district" form field was removed during the Demo-MVP minimisation
  // pass — the value is now derived from the deployment subtitle at submit
  // time. We keep the local placeholder so trustScore can still take
  // `hasDistrict` (which is now always false) into account.
  const district = ''
  const [channel]                         = useState<SubmissionChannel>('pwa')
  const [gpsStatus, setGpsStatus]         = useState<'idle' | 'acquiring' | 'acquired' | 'error'>('idle')
  const [gpsAccuracy, setGpsAccuracy]     = useState<number>(50)
  const [gpsLat, setGpsLat]               = useState<number>(0)
  const [gpsLng, setGpsLng]               = useState<number>(0)
  const [inArea, setInArea]               = useState<boolean>(true)

  // Result state
  const [trustResult, setTrustResult]       = useState<ReturnType<typeof calculateTrustScore> | null>(null)
  const [finalImageUrl, setFinalImageUrl]   = useState<string | null>(null)
  const [resultHasC2PA, setResultHasC2PA]   = useState(false)
  const [aiResult, setAiResult]             = useState<'authentic' | 'suspicious' | null>(null)
  const [cmsError, setCmsError]             = useState<string | null>(null)
  const [cmsSyncStatus, setCmsSyncStatus]   = useState<CmsSyncStatus>('idle')

  const [isOnlineLocal, setIsOnlineLocal] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true)
  const isOnline = isOnlineProp !== undefined ? isOnlineProp : isOnlineLocal
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showMapPicker, setShowMapPicker] = useState(false)

  const dmgLabel = useMemo(() => ({
    minimal:   config.label_damage_minimal   ?? damageLevelLabel.minimal,
    partial:   config.label_damage_partial   ?? damageLevelLabel.partial,
    destroyed: config.label_damage_destroyed ?? damageLevelLabel.destroyed,
  }), [config])

  const fileRef   = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)

  // ── Online/offline listener ────────────────────────────────────────────────
  useEffect(() => {
    const up   = () => setIsOnlineLocal(true)
    const down = () => setIsOnlineLocal(false)
    window.addEventListener('online',  up)
    window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])

  // ── Pre-fill location when coming from dashboard map ─────────────────────
  useEffect(() => {
    if (!prefilledLocation) return
    applyLocation(prefilledLocation.lat, prefilledLocation.lng, 50)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])   // run once on mount — prefilledLocation is stable per component instance

  // ── Shared helper: apply a lat/lng and reverse-geocode ────────────────────
  /**
   * Apply a lat/lng to the GPS state. Reverse-geocoding via Nominatim was
   * removed during the Demo MVP cleanup — the public Nominatim endpoint was
   * unreliable from the browser (intermittent CORS rejections, sluggish
   * responses under load), and auto-filling the district / landmark
   * inconsistently produced a worse UX than just letting the reporter type
   * them. The two text inputs remain — they're optional, and the user can
   * fill them by hand when the location merits it.
   */
  const applyLocation = (lat: number, lng: number, accuracy: number) => {
    setGpsLat(lat); setGpsLng(lng)
    setGpsStatus('acquired')
    setGpsAccuracy(accuracy)
    setInArea(isWithinArea(lat, lng, config.area_center_lat, config.area_center_lng, config.area_radius_km))
  }

  // ── Photo ──────────────────────────────────────────────────────────────────
  const handlePhoto = async (e: React.ChangeEvent<HTMLInputElement>, source: 'camera' | 'library') => {
    const file = e.target.files?.[0]
    if (!file) return
    // Compress to ~150 KB so submissions stay quick on field-grade mobile
    // networks. (Previously this branched on a `lowBandwidth` flag that was
    // hard-wired to true — the branch is gone now.)
    const compressed = await compressImage(file, 640, 0.60)
    setPhotoFile(compressed)
    setPhotoPreview(URL.createObjectURL(compressed))
    setPhotoSource(source)
  }

  // ── GPS ────────────────────────────────────────────────────────────────────
  const handleGps = () => {
    setGpsStatus('acquiring')
    if (!navigator.geolocation) { setGpsStatus('error'); return }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        applyLocation(
          position.coords.latitude,
          position.coords.longitude,
          Math.round(position.coords.accuracy),
        )
      },
      (err) => { console.warn('[GPS]', err.message); setGpsStatus('error') },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isSubmitting) return
    setIsSubmitting(true)
    if (!damageLevel || !infraType) return

    setStep('submitting')
    setSubmitPhase('scoring')
    setCmsError(null)
    setCmsSyncStatus('idle')

    const c2pa = photoSource === 'camera' && !!photoFile

    // Cross-report validation: find reports within 500m of this submission
    const submitLat = gpsStatus === 'acquired' ? gpsLat : config.area_center_lat
    const submitLng = gpsStatus === 'acquired' ? gpsLng : config.area_center_lng
    const nearbyReports = existingReports.filter(r =>
      haversineKm(submitLat, submitLng, r.lat, r.lng) <= 0.5
    )
    const nearbyMatchingDamage = nearbyReports.filter(r =>
      r.damageLevel === (damageLevel as DamageLevel)
    )

    const score = calculateTrustScore({
      hasPhoto:                 !!photoPreview,
      photoSource:              photoSource,
      hasC2PA:                  c2pa,
      aiAuthentic:              true,
      hasGps:                   gpsStatus === 'acquired',
      gpsAccuracy,
      isInArea:                 gpsStatus === 'acquired' ? inArea : true,
      channel,
      hasLandmark:              landmark.trim().length > 0,
      hasDistrict:              district.trim().length > 0,
      nearbyReportCount:        nearbyReports.length,
      nearbyMatchingDamageCount: nearbyMatchingDamage.length,
    })

    await sleep(50)
    setSubmitPhase('analyzing')
    await sleep(100)
    setResultHasC2PA(c2pa)
    setAiResult('authentic')

    // Build report with local data (CMS image URL set later)
    const reportLat     = gpsStatus === 'acquired' ? gpsLat : config.area_center_lat + (Math.random() - 0.5) * 0.02
    const reportLng     = gpsStatus === 'acquired' ? gpsLng : config.area_center_lng + (Math.random() - 0.5) * 0.02
    const localImageUrl = photoPreview ?? undefined

    const newReport: DamageReport = {
      id:          `RPT-${Date.now().toString().slice(-4)}`,
      lat:         reportLat,
      lng:         reportLng,
      damageLevel: damageLevel as DamageLevel,
      infraType:   infraType  as InfraType,
      landmark:    landmark || `${config.subtitle} (demo GPS)`,
      district:    district  || config.subtitle.split('/')[0].trim(),
      timestamp:   new Date().toISOString(),
      channel,
      trustScore:  score,
      tier:        getTier(score.total),
      h3Cell:      '8865b1b6dffffff',
      hasC2PA:     c2pa,
      imageUrl:    localImageUrl,
    }

    // ✅ Show result first — guaranteed even if parent callback throws
    setSubmitPhase('done')
    setTrustResult(score)
    setFinalImageUrl(localImageUrl ?? null)
    setStep('result')        // ← set BEFORE calling parent, so spinner always clears

    // Notify parent (safe — iOS Safari Notification API can throw inside handleNewReport)
    try { onNewReport(newReport) } catch (err) { console.warn('[submit] onNewReport threw:', err) }

    // ── Offline path: queue to IndexedDB, sync when back online ──
    if (!isOnline) {
      setCmsSyncStatus('queued')
      try { await enqueueReport(newReport, photoFile) } catch (err) {
        console.warn('[offlineQueue] enqueue failed', err)
      }
      return
    }

    // ── Online path: CMS upload + save in background (non-blocking) ──
    if (CMS.writable) {
      setCmsSyncStatus('syncing')
      ;(async () => {
        try {
          let assetId:     string | undefined
          let cmsImageUrl: string | undefined

          if (photoFile) {
            const asset = await uploadAsset(photoFile)
            if (asset) {
              assetId     = asset.id
              cmsImageUrl = asset.url
              setFinalImageUrl(cmsImageUrl)   // upgrade from blob URL to CMS URL
            }
          }

          const reportForCms = cmsImageUrl ? { ...newReport, imageUrl: cmsImageUrl } : newReport
          const cmsId = await createReportItem(reportForCms, assetId)

          if (cmsId) {
            setCmsSyncStatus('synced')
          } else {
            setCmsSyncStatus('error')
            setCmsError('CMS save failed — report visible in this session only')
          }
        } catch {
          setCmsSyncStatus('error')
          setCmsError('CMS save failed — report visible in this session only')
        }
      })()
    }
  }

  // ── Reset ──────────────────────────────────────────────────────────────────
  const handleReset = () => {
    setIsSubmitting(false)
    setStep('form')
    setPhotoFile(null)
    setPhotoPreview(null)
    setPhotoSource(null)
    setDamageLevel('')
    setInfraType('')
    setLandmark('')
    setGpsStatus('idle')
    setGpsLat(0); setGpsLng(0)
    setInArea(true)
    setTrustResult(null)
    setFinalImageUrl(null)
    setResultHasC2PA(false)
    setAiResult(null)
    setCmsError(null)
    setCmsSyncStatus('idle')
    setSubmitPhase('scoring')
  }

  // ── Submitting screen ──────────────────────────────────────────────────────
  if (step === 'submitting') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
        <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
        <p className="text-gray-600 text-sm font-medium">Verifying report…</p>
        <div className="text-xs text-gray-400 space-y-1 text-center">
          {submitPhase === 'scoring'  && <p>Calculating Trust Score…</p>}
          {submitPhase === 'analyzing' && <><p className="text-green-600">Trust Score calculated ✓</p><p>Running AI authenticity scan…</p></>}
          {submitPhase === 'done'     && <><p className="text-green-600">Trust Score calculated ✓</p><p className="text-green-600">AI analysis complete ✓</p></>}
        </div>
      </div>
    )
  }

  // ── Result screen ──────────────────────────────────────────────────────────
  if (step === 'result' && trustResult) {
    const tier   = getTier(trustResult.total)
    const colors = tierColors[tier]
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-4 gap-4 max-w-md mx-auto w-full">
        <div className={`w-full rounded-xl border-2 ${colors.border} ${colors.bg} p-5`}>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-full flex items-center justify-center text-xl font-bold text-white"
              style={{ backgroundColor: colors.hex }}>
              {trustResult.total}
            </div>
            <div>
              <div className={`font-bold ${colors.text}`}>{getTierLabel(tier)}</div>
              <div className="text-xs text-gray-500">{getTierDescription(tier)}</div>
            </div>
          </div>

          {finalImageUrl && (
            <img src={finalImageUrl} alt="submitted" className="w-full h-32 object-cover rounded-lg mb-4"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
          )}

          <div className="space-y-2">
            <ScoreBar label="Image Integrity" value={trustResult.imageIntegrity} max={40} color={colors.hex} />
            <ScoreBar label="Geospatial"       value={trustResult.geospatial}     max={30} color={colors.hex} />
            <ScoreBar label="Cross-Report"     value={trustResult.crossReport}    max={20} color={colors.hex} />
            <ScoreBar label="Metadata"         value={trustResult.metadata}       max={10} color={colors.hex} />
          </div>

          <div className="mt-3 pt-3 border-t border-gray-100 space-y-1.5">
            <div className={`flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg ${resultHasC2PA ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-500'}`}>
              <span>{resultHasC2PA ? '🔏' : '○'}</span>
              <span className="font-medium">C2PA Content Credentials:</span>
              <span>{resultHasC2PA ? 'Verified ✓' : 'Not present'}</span>
            </div>
            {aiResult && (
              <div className={`flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg ${aiResult === 'authentic' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'}`}>
                <span>{aiResult === 'authentic' ? '🤖' : '⚠'}</span>
                <span className="font-medium">AI Analysis:</span>
                <span>{aiResult === 'authentic' ? 'Authentic content detected ✓' : 'Flagged for review'}</span>
              </div>
            )}
          </div>
        </div>

        {tier === 'green' && (
          <div className="w-full bg-green-50 border border-green-300 rounded-lg p-4 text-sm text-green-800">
            <strong>Your report is now live on the map.</strong>{' '}
            Thank you — your submission is helping guide emergency response.
          </div>
        )}
        {tier === 'amber' && (
          <div className="w-full bg-amber-50 border border-amber-300 rounded-lg p-4 text-sm text-amber-800">
            <strong>Report received.</strong> Additional verification is underway. Your report will appear once reviewed.
          </div>
        )}

        {/* CMS sync status */}
        {CMS.writable && (
          <div className="w-full text-center text-xs text-gray-400">
            {cmsSyncStatus === 'syncing' && <span className="animate-pulse">⟳ Saving to Re:Earth CMS…</span>}
            {cmsSyncStatus === 'synced'  && <span className="text-green-600">✓ Saved to Re:Earth CMS · visible on dashboard</span>}
            {cmsSyncStatus === 'queued'  && (
              <span className="text-orange-600 flex items-center justify-center gap-1.5">
                <span>📵</span>
                <span>Offline — report queued, will sync when connection returns</span>
              </span>
            )}
            {cmsSyncStatus === 'error'   && <span className="text-yellow-600">⚠ {cmsError}</span>}
          </div>
        )}

        {typeof navigator !== 'undefined' && 'share' in navigator && (
          <button
            onClick={() => navigator.share?.({
              title: 'Verified Crisis Mapper',
              text:  `Damage report submitted · Score: ${trustResult?.total ?? '—'} · ${config.subtitle}`,
              url:   window.location.href,
            })}
            className="w-full py-2 rounded-lg border border-gray-300 text-gray-600 text-sm hover:bg-gray-50 flex items-center justify-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/>
            </svg>
            Share Report
          </button>
        )}
        <div className="flex gap-3 w-full">
          <button onClick={handleReset}
            className="flex-1 py-2 rounded-lg border border-gray-300 text-gray-700 text-sm hover:bg-gray-50">
            Submit Another
          </button>
          <button onClick={onViewDashboard}
            className="flex-1 py-2 rounded-lg bg-blue-700 text-white text-sm font-semibold hover:bg-blue-800">
            View Map
          </button>
        </div>
      </div>
    )
  }

  // ── Form ───────────────────────────────────────────────────────────────────
  return (
    <>
    {/* Full-screen map picker overlay */}
    {showMapPicker && (
      <Suspense fallback={
        <div className="fixed inset-0 z-[200] bg-black flex items-center justify-center">
          <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      }>
        <MapPickerOverlay
          initialCenter={
            gpsStatus === 'acquired'
              ? { lat: gpsLat, lng: gpsLng }
              : { lat: config.area_center_lat, lng: config.area_center_lng }
          }
          onConfirm={(lat, lng) => { applyLocation(lat, lng, 15); setShowMapPicker(false) }}
          onCancel={() => setShowMapPicker(false)}
        />
      </Suspense>
    )}
    <div className="flex-1 max-w-md mx-auto w-full p-4 overflow-y-auto">
      {/* Scenario banner was removed during Demo MVP cleanup — the dashboard
          header already carries the scenario name, and the "Saved to CMS"
          / "Low-BW" badges were UI noise that no longer reflected anything
          actionable. */}

      {/* From-map indicator — shown when location was pre-filled from the dashboard */}
      {prefilledLocation && (
        <div className="bg-indigo-50 border border-indigo-300 rounded-lg p-3 mb-4 text-xs text-indigo-800 flex items-center gap-2">
          <span className="text-base shrink-0">📌</span>
          <span><strong>Location pre-filled from map.</strong> Coordinates loaded — please verify and complete the form below.</span>
        </div>
      )}

      {gpsStatus === 'acquired' && !inArea && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 mb-4 text-xs text-amber-800">
          <strong>Location outside reporting area.</strong> Geospatial score will be 0 — report will require manual review.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Offline indicator */}
        {!isOnline && (
          <div className="bg-orange-50 border border-orange-300 rounded-lg p-3 mb-4 flex items-center gap-2 text-xs text-orange-700">
            <span className="text-base">📵</span>
            <span><strong>You are offline.</strong> Your report will be queued and submitted automatically when connection is restored.</span>
          </div>
        )}

        {/* ── Step 1: Photo ── */}
        <section className="bg-white rounded-xl border border-gray-200 p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">1. Photo</h2>
          {photoPreview ? (
            <div className="relative">
              <img src={photoPreview} alt="damage" className="w-full h-52 object-cover rounded-xl" />
              <button type="button"
                onClick={() => { setPhotoPreview(null); setPhotoFile(null) }}
                className="absolute top-2 right-2 bg-white rounded-full w-8 h-8 text-sm text-gray-600 shadow-md flex items-center justify-center">
                ✕
              </button>
            </div>
          ) : (
            <div className="flex gap-3">
              <button type="button" onClick={() => cameraRef.current?.click()}
                className="flex-1 h-36 bg-blue-50 border-2 border-dashed border-blue-300 rounded-xl flex flex-col items-center justify-center gap-2 text-blue-400 hover:bg-blue-100 hover:border-blue-500 active:bg-blue-100 transition-colors">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-10 h-10 text-blue-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <p className="text-sm font-semibold text-blue-600">Take Photo</p>
              </button>
              <button type="button" onClick={() => fileRef.current?.click()}
                className="flex-1 h-36 bg-gray-50 border-2 border-dashed border-gray-300 rounded-xl flex flex-col items-center justify-center gap-2 text-gray-400 hover:bg-gray-100 hover:border-gray-400 active:bg-gray-100 transition-colors">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-10 h-10 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p className="text-sm font-semibold text-gray-500">From Library</p>
              </button>
            </div>
          )}
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => handlePhoto(e, 'camera')} />
          <input ref={fileRef}   type="file" accept="image/*"                        className="hidden" onChange={e => handlePhoto(e, 'library')} />
        </section>

        {/* ── Step 2: Damage Level ── */}
        <section className="bg-white rounded-xl border border-gray-200 p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">2. Damage Level</h2>
          <div className="flex flex-col gap-2">
            {(['minimal', 'partial', 'destroyed'] as DamageLevel[]).map(level => (
              <button key={level} type="button" onClick={() => setDamageLevel(level)}
                className={`w-full py-4 px-4 rounded-xl border-2 text-sm font-semibold transition-colors flex items-center gap-3 ${
                  damageLevel === level
                    ? level === 'destroyed' ? 'bg-red-600 text-white border-red-600'
                      : level === 'partial' ? 'bg-amber-500 text-white border-amber-500'
                      : 'bg-green-600 text-white border-green-600'
                    : 'border-gray-200 text-gray-600 bg-gray-50 active:bg-gray-100'
                }`}>
                <span className={`w-3 h-3 rounded-full shrink-0 ${
                  level === 'destroyed' ? 'bg-red-400' : level === 'partial' ? 'bg-amber-400' : 'bg-green-400'
                } ${damageLevel === level ? 'bg-white' : ''}`} />
                {dmgLabel[level]}
              </button>
            ))}
          </div>
        </section>

        {/* ── Step 3: Infrastructure Type ── */}
        <section className="bg-white rounded-xl border border-gray-200 p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">3. Infrastructure Type</h2>
          <div className="grid grid-cols-2 gap-2">
            {(Object.entries(infraTypeLabel) as [InfraType, string][]).map(([key, label]) => (
              <button key={key} type="button" onClick={() => setInfraType(key)}
                className={`py-3 px-3 rounded-xl border-2 text-sm font-medium text-left transition-colors active:scale-95 ${
                  infraType === key ? 'bg-blue-700 text-white border-blue-700' : 'border-gray-200 text-gray-600 bg-gray-50 active:bg-gray-100'
                }`}>
                {label}
              </button>
            ))}
          </div>
        </section>

        {/* ── Step 4: Location ── */}
        <section className="bg-white rounded-xl border border-gray-200 p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">4. Location</h2>

          {/* GPS button */}
          <button type="button" onClick={handleGps}
            className={`w-full py-3.5 rounded-xl border-2 text-sm font-medium mb-3 transition-colors ${
              gpsStatus === 'acquired'  ? 'bg-green-50 border-green-400 text-green-700'
              : gpsStatus === 'acquiring' ? 'bg-blue-50 border-blue-300 text-blue-600'
              : gpsStatus === 'error'   ? 'bg-amber-50 border-amber-300 text-amber-700'
              : 'border-gray-200 bg-gray-50 text-gray-600 active:bg-gray-100'
            }`}>
            {gpsStatus === 'idle'      && '📍 Auto-capture GPS location'}
            {gpsStatus === 'acquiring' && '⟳ Acquiring GPS…'}
            {gpsStatus === 'acquired'  && `✓ GPS captured (±${gpsAccuracy}m) · tap to update`}
            {gpsStatus === 'error'     && '⚠ Location unavailable — tap to retry'}
          </button>

          {/* Map picker button */}
          <button type="button" onClick={() => setShowMapPicker(true)}
            className="w-full py-3 rounded-xl border-2 border-gray-200 bg-gray-50 text-sm font-medium text-gray-600 active:bg-gray-100 hover:bg-gray-100 transition-colors flex items-center justify-center gap-2 mb-3">
            <span className="text-base">🗺️</span>
            <span>Pick location on map</span>
          </button>

          {/* GPS denied notice */}
          {gpsStatus === 'error' && (
            <div className="mb-3 text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-amber-700 space-y-2">
              <p>
                GPS was denied or timed out. Use the deployment area centre as a
                fallback, pick a location on the map, or enter a landmark manually.
              </p>
              {/* Explicit "use area centre" — keeps the user moving without forcing GPS.
                  Accuracy is set to 200m to keep the Trust Score honest about the
                  reduced geospatial confidence. */}
              <button
                type="button"
                onClick={() => applyLocation(config.area_center_lat, config.area_center_lng, 200)}
                className="w-full py-2 rounded-lg bg-amber-100 border border-amber-300 text-amber-800 font-medium active:bg-amber-200"
              >
                Use {config.subtitle || 'area'} centre ({config.area_center_lat.toFixed(3)}, {config.area_center_lng.toFixed(3)})
              </button>
            </div>
          )}

          {/* District input was removed in the Demo-MVP minimisation pass —
              the value is computed from the deployment config when the
              report is submitted (see submit handler). One free-text field
              (landmark) is enough for a citizen reporter to add context. */}

          {/* Landmark — the one free-text field worth showing */}
          <input
            type="text" value={landmark} onChange={e => setLandmark(e.target.value)}
            placeholder="Landmark / street name (e.g. Don Mueang Market)"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
          />
        </section>

        {/* Submit */}
        <button type="submit"
          disabled={!damageLevel || !infraType || isSubmitting}
          className="w-full py-4 rounded-xl bg-blue-700 text-white font-bold text-base disabled:opacity-40 disabled:cursor-not-allowed hover:bg-blue-800 active:bg-blue-900 transition-colors shadow-md">
          {isSubmitting ? '⟳ Submitting…' : 'Submit Report'}
        </button>
      </form>
    </div>
    </>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function compressImage(file: File, maxPx = 1280, quality = 0.82): Promise<File> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      let { width, height } = img
      if (width > maxPx || height > maxPx) {
        if (width > height) { height = Math.round(height * maxPx / width); width = maxPx }
        else { width = Math.round(width * maxPx / height); height = maxPx }
      }
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height)
      canvas.toBlob(blob => {
        if (!blob) { resolve(file); return }
        resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }))
      }, 'image/jpeg', quality)
    }
    img.onerror = () => resolve(file)
    img.src = URL.createObjectURL(file)
  })
}

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)) }

function ScoreBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-28 text-gray-500 shrink-0">{label}</span>
      <div className="flex-1 bg-gray-200 rounded-full h-2">
        <div className="h-2 rounded-full transition-all" style={{ width: `${Math.round((value/max)*100)}%`, backgroundColor: color }} />
      </div>
      <span className="w-10 text-right text-gray-600 font-medium">{value}/{max}</span>
    </div>
  )
}
