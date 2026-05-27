import { useState, useEffect, useMemo } from 'react'
import type { DamageReport, ReviewMap, ReviewStatus } from '../types'
import { tierColors, damageLevelLabel, infraTypeLabel } from '../utils/trustColors'
import { getTierLabel } from '../utils/trustScore'

type ReviewTab = 'all' | 'pending' | 'approved' | 'rejected'

interface Props {
  reports: DamageReport[]
  reviewMap: ReviewMap
  /** Pass null to revert a report back to Pending (removes the review decision). */
  onReview: (id: string, status: ReviewStatus | null, reason?: string) => void
  isAuthed: boolean
  onAuthSuccess: () => void
  onLogout: () => void
  /** 6-digit PIN from CMS deployment-config; falls back to '000000' when not set */
  adminPin?: string
}

export default function AdminView({ reports, reviewMap, onReview, isAuthed, onAuthSuccess, onLogout, adminPin }: Props) {
  const [pinInput, setPinInput]     = useState('')
  const [pinError, setPinError]     = useState(false)
  const [failCount, setFailCount]   = useState(0)
  const [lockedUntil, setLockedUntil] = useState<number>(0)

  const [, setTick] = useState(0)  // forces re-render for countdown
  const isLocked = Date.now() < lockedUntil
  const lockSecsLeft = Math.ceil((lockedUntil - Date.now()) / 1000)
  const [tab,      setTab]      = useState<ReviewTab>('pending')

  // Countdown ticker — only runs while locked
  useEffect(() => {
    if (!isLocked) return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [isLocked])
  const [pendingRejectId, setPendingRejectId] = useState<string | null>(null)
  const [rejectReason, setRejectReason]       = useState('')

  // ── All hooks at top level ────────────────────────────────────────────────────

  const pendingCount  = useMemo(() => reports.filter(r => !reviewMap[r.id]).length,               [reports, reviewMap])
  const approvedCount = useMemo(() => reports.filter(r => reviewMap[r.id] === 'approved').length, [reports, reviewMap])
  const rejectedCount = useMemo(() => reports.filter(r => reviewMap[r.id] === 'rejected').length, [reports, reviewMap])

  const tabFilters: { label: string; key: ReviewTab; count: number }[] = [
    { label: 'All',      key: 'all',      count: reports.length },
    { label: 'Pending',  key: 'pending',  count: pendingCount },
    { label: 'Approved', key: 'approved', count: approvedCount },
    { label: 'Rejected', key: 'rejected', count: rejectedCount },
  ]

  const filtered = useMemo(() => {
    if (tab === 'all')      return reports
    if (tab === 'pending')  return reports.filter(r => !reviewMap[r.id])
    if (tab === 'approved') return reports.filter(r => reviewMap[r.id] === 'approved')
    return reports.filter(r => reviewMap[r.id] === 'rejected')
  }, [reports, reviewMap, tab])

  const sorted = useMemo(() => [...filtered].sort((a, b) => {
    const aStatus = reviewMap[a.id]
    const bStatus = reviewMap[b.id]
    if (!aStatus && bStatus) return -1
    if (aStatus && !bStatus) return 1
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  }), [filtered, reviewMap])

  // ── PIN handlers ─────────────────────────────────────────────────────────────

  const handleKey = (digit: string) => {
    if (pinInput.length >= 6) return
    setPinInput(p => p + digit)
  }

  const handleBackspace = () => {
    setPinInput(p => p.slice(0, -1))
  }

  const handleLogin = () => {
    if (pinInput.length < 6 || isLocked) return
    if (pinInput === (adminPin ?? '000000')) {
      onAuthSuccess()
      setPinInput('')
      setPinError(false)
      setFailCount(0)
    } else {
      const next = failCount + 1
      setFailCount(next)
      setPinError(true)
      // Lockout: 3 failures → 30s, 6+ failures → 120s
      if (next >= 3) setLockedUntil(Date.now() + (next >= 6 ? 120_000 : 30_000))
      setTimeout(() => { setPinInput(''); setPinError(false) }, 900)
    }
  }

  // ── PIN entry screen ──────────────────────────────────────────────────────────

  if (!isAuthed) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-gray-50 p-6">
        <div className="w-full max-w-xs">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-blue-800 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-md">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-800">Admin Login</h2>
            <p className="text-sm text-gray-500 mt-1">Enter your 6-digit PIN to continue</p>
          </div>

          {/* PIN dots */}
          <div className={`flex justify-center gap-4 mb-3 ${pinError ? 'animate-bounce' : ''}`}>
            {[0, 1, 2, 3, 4, 5].map(i => (
              <div key={i} className={`w-5 h-5 rounded-full border-2 transition-all duration-150 ${
                i < pinInput.length
                  ? pinError ? 'bg-red-500 border-red-500' : 'bg-blue-700 border-blue-700'
                  : 'border-gray-400 bg-transparent'
              }`}/>
            ))}
          </div>

          <div className="h-5 text-center mb-4">
            {isLocked
              ? <p className="text-orange-600 text-sm font-medium">🔒 Locked — wait {lockSecsLeft}s</p>
              : pinError && <p className="text-red-500 text-sm">Wrong PIN — please try again</p>
            }
          </div>

          {/* Numpad */}
          <div className="grid grid-cols-3 gap-3 mb-4">
            {['1','2','3','4','5','6','7','8','9'].map(d => (
              <button key={d} onClick={() => handleKey(d)}
                className="h-14 rounded-2xl bg-white border border-gray-200 text-xl font-semibold text-gray-800 shadow-sm active:bg-gray-100 hover:bg-gray-50 transition-colors">
                {d}
              </button>
            ))}
            <div/>
            <button onClick={() => handleKey('0')}
              className="h-14 rounded-2xl bg-white border border-gray-200 text-xl font-semibold text-gray-800 shadow-sm active:bg-gray-100 hover:bg-gray-50 transition-colors">
              0
            </button>
            <button onClick={handleBackspace}
              className="h-14 rounded-2xl bg-white border border-gray-200 flex items-center justify-center shadow-sm active:bg-gray-100 hover:bg-gray-50 transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M3 12l6.414 6.414a2 2 0 001.414.586H19a2 2 0 002-2V7a2 2 0 00-2-2h-8.172a2 2 0 00-1.414.586L3 12z"/>
              </svg>
            </button>
          </div>

          {/* Login button */}
          <button
            onClick={handleLogin}
            disabled={pinInput.length < 6 || isLocked}
            className={`w-full h-14 rounded-2xl text-base font-bold transition-all shadow-sm ${
              isLocked
                ? 'bg-orange-100 text-orange-500 cursor-not-allowed'
                : pinInput.length === 6
                  ? 'bg-blue-700 text-white hover:bg-blue-800 active:bg-blue-900'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}>
            {isLocked ? `🔒 ${lockSecsLeft}s` : 'Login'}
          </button>

          <p className="text-center text-xs text-gray-400 mt-4">Demo PIN: 000000</p>
        </div>
      </div>
    )
  }

  // ── Authenticated: review panel ───────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-gray-50">

      {/* Panel header */}
      <div className="bg-blue-900 text-white px-4 py-3 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 text-blue-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
            </svg>
            <span className="font-semibold text-sm">Admin Review Panel</span>
            {pendingCount > 0 && (
              <span className="bg-amber-400 text-amber-900 text-xs font-bold px-1.5 py-0.5 rounded-full">
                {pendingCount} pending
              </span>
            )}
          </div>
          <button onClick={() => { onLogout(); setPinInput('') }}
            className="text-blue-300 hover:text-white text-xs transition-colors flex items-center gap-1">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
            </svg>
            Logout
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="bg-white border-b border-gray-200 flex shrink-0">
        {tabFilters.map(f => (
          <button key={f.key} onClick={() => setTab(f.key)}
            className={`flex-1 py-2.5 text-xs font-semibold transition-colors relative ${
              tab === f.key ? 'text-blue-700' : 'text-gray-500 hover:text-gray-700'
            }`}>
            {f.label}
            {f.count > 0 && (
              <span className={`ml-1 text-[10px] px-1 py-0.5 rounded-full ${
                tab === f.key ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'
              }`}>{f.count}</span>
            )}
            {tab === f.key && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-700 rounded-full"/>
            )}
          </button>
        ))}
      </div>

      {/* Report list */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-12 h-12 mx-auto mb-3 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
            </svg>
            <p className="text-sm">No reports in this category</p>
          </div>
        ) : sorted.map(report => {
          const status = reviewMap[report.id]
          const hex    = tierColors[report.tier].hex
          return (
            <div key={report.id}
              className={`mx-3 my-2 rounded-xl border shadow-sm overflow-hidden ${
                status === 'approved' ? 'border-green-200 bg-green-50'
                : status === 'rejected' ? 'border-gray-200 bg-gray-100 opacity-60'
                : 'border-gray-200 bg-white'
              }`}>

              {/* ── Card header ── */}
              <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full shrink-0" style={{backgroundColor: hex}}/>
                  <span className="text-xs font-bold text-gray-700">{report.id}</span>
                  <span className="text-xs text-gray-400">{getTierLabel(report.tier)}</span>
                </div>
                {status ? (
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                    status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'
                  }`}>
                    {status === 'approved' ? '✓ Approved' : '✗ Rejected'}
                  </span>
                ) : (
                  <span className="text-lg font-bold" style={{color: hex}}>{report.trustScore.total}</span>
                )}
              </div>

              {/* ── Image + basic info ── */}
              <div className="flex gap-3 px-3 pb-2">
                {report.imageUrl ? (
                  <img src={report.imageUrl} alt="" className="w-20 h-20 rounded-lg object-cover shrink-0 border border-gray-200"
                    onError={e => { (e.target as HTMLImageElement).style.display='none' }}/>
                ) : (
                  <div className="w-20 h-20 rounded-lg bg-gray-100 flex items-center justify-center shrink-0 border border-gray-200">
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-7 h-7 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                    </svg>
                  </div>
                )}
                <div className="flex-1 min-w-0 space-y-0.5 pt-0.5">
                  <div className="text-sm font-semibold text-gray-800 truncate">{report.district}</div>
                  <div className="text-xs text-gray-500">{damageLevelLabel[report.damageLevel]} · {infraTypeLabel[report.infraType]}</div>
                  <div className="text-xs text-gray-400 truncate">{report.landmark}</div>
                  <div className="text-[10px] text-gray-400 flex items-center gap-1">
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
                    </svg>
                    {formatDate(report.timestamp)}
                  </div>
                  <div className="text-[10px] text-gray-400 flex items-center gap-1">
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
                    </svg>
                    {report.lat.toFixed(4)}, {report.lng.toFixed(4)}
                  </div>
                </div>
              </div>

              {/* ── Trust score breakdown ── */}
              <div className="px-3 pb-3 space-y-1.5 border-t border-gray-100 pt-2">
                <AdminMiniBar label="Image" value={report.trustScore.imageIntegrity} max={40} color={hex}/>
                <AdminMiniBar label="Geo"   value={report.trustScore.geospatial}     max={30} color={hex}/>
                <AdminMiniBar label="Cross" value={report.trustScore.crossReport}    max={20} color={hex}/>
                <AdminMiniBar label="Meta"  value={report.trustScore.metadata}       max={10} color={hex}/>
              </div>

              {/* ── Action buttons ── */}
              <div className="border-t border-gray-100">
                {pendingRejectId === report.id ? (
                  /* Inline reject confirmation */
                  <div className="p-3 space-y-2">
                    <p className="text-xs font-semibold text-gray-600">Reject reason:</p>
                    <select
                      value={rejectReason}
                      onChange={e => setRejectReason(e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-red-400">
                      <option value="">— Select reason —</option>
                      <option value="Image unclear or low quality">Image unclear or low quality</option>
                      <option value="Duplicate report">Duplicate report</option>
                      <option value="Location mismatch">Location mismatch</option>
                      <option value="Outside reporting area">Outside reporting area</option>
                      <option value="Suspected AI-generated image">Suspected AI-generated image</option>
                      <option value="Other">Other</option>
                    </select>
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setPendingRejectId(null); setRejectReason('') }}
                        className="flex-1 py-2 text-xs text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50">
                        Cancel
                      </button>
                      <button
                        onClick={() => { onReview(report.id, 'rejected', rejectReason); setPendingRejectId(null); setRejectReason('') }}
                        disabled={!rejectReason}
                        className="flex-1 py-2 text-xs font-semibold text-white bg-red-500 rounded-lg hover:bg-red-600 disabled:opacity-40">
                        Confirm Reject
                      </button>
                    </div>
                  </div>
                ) : status ? (
                  /* Approved or Rejected — show all 3 buttons */
                  <div className="flex">
                    <button
                      onClick={() => onReview(report.id, 'approved')}
                      className={`flex-1 py-3 flex items-center justify-center gap-1 text-xs font-semibold transition-colors border-r border-gray-100 ${
                        status === 'approved' ? 'bg-green-500 text-white' : 'text-green-600 hover:bg-green-50 active:bg-green-100'
                      }`}>
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
                      </svg>
                      Approve
                    </button>
                    {/* Revert to Pending */}
                    <button
                      onClick={() => onReview(report.id, null)}
                      className="flex-1 py-3 flex items-center justify-center gap-1 text-xs font-semibold text-amber-600 hover:bg-amber-50 active:bg-amber-100 transition-colors border-r border-gray-100">
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/>
                      </svg>
                      Pending
                    </button>
                    <button
                      onClick={() => { setPendingRejectId(report.id); setRejectReason('') }}
                      className={`flex-1 py-3 flex items-center justify-center gap-1 text-xs font-semibold transition-colors ${
                        status === 'rejected' ? 'bg-red-400 text-white' : 'text-red-500 hover:bg-red-50 active:bg-red-100'
                      }`}>
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                      </svg>
                      Reject
                    </button>
                  </div>
                ) : (
                  /* Pending — original 2-button layout */
                  <div className="flex">
                    <button
                      onClick={() => onReview(report.id, 'approved')}
                      className="flex-1 py-3 flex items-center justify-center gap-1.5 text-sm font-semibold text-green-600 hover:bg-green-50 active:bg-green-100 transition-colors border-r border-gray-100">
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
                      </svg>
                      Approve
                    </button>
                    <button
                      onClick={() => { setPendingRejectId(report.id); setRejectReason('') }}
                      className="flex-1 py-3 flex items-center justify-center gap-1.5 text-sm font-semibold text-red-500 hover:bg-red-50 active:bg-red-100 transition-colors">
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                      </svg>
                      Reject
                    </button>
                  </div>
                )}
              </div>
            </div>
          )
        })}
        <div className="h-4"/>
      </div>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function AdminMiniBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-gray-400 w-10 shrink-0">{label}</span>
      <div className="flex-1 bg-gray-200 rounded-full h-1.5">
        <div className="h-1.5 rounded-full transition-all" style={{width:`${(value/max)*100}%`, backgroundColor: color}}/>
      </div>
      <span className="text-gray-500 w-9 text-right">{value}/{max}</span>
    </div>
  )
}

/** Locale-independent formatter — avoids "Invalid Date" on mobile browsers */
function formatDate(iso: string): string {
  if (!iso) return '—'
  try {
    const normalized = iso
      .replace(' ', 'T')
      .replace(' +0000 UTC', 'Z')
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
