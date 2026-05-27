#!/usr/bin/env node
/**
 * bootstrap-bangkok.mjs — One-shot CMS reset for the Bangkok demo.
 *
 * Idempotent end-to-end fix for "the live demo still shows Tokyo":
 *
 *   1. PATCH the existing `deployment-config` row(s) so the dashboard
 *      reads Bangkok bounds, centre, and title strings.
 *   2. DELETE every existing `damage-report` item (legacy Tokyo test rows
 *      from earlier development), then POST the 28 Bangkok mockReports
 *      shipped in src/data/mockReports.ts.
 *   3. (Optional) Skip the wipe with --keep-existing if the user wants to
 *      append rather than replace.
 *
 * Trigger paths:
 *
 *   GitHub UI (no local token needed):
 *     Actions → "Bootstrap CMS to Bangkok" → Run workflow
 *
 *   Locally (requires demo/.env with VITE_CMS_TOKEN):
 *     cd demo && node scripts/bootstrap-bangkok.mjs
 *     cd demo && node scripts/bootstrap-bangkok.mjs --keep-existing
 *     cd demo && node scripts/bootstrap-bangkok.mjs --dry-run
 *
 * Exit codes:
 *   0  success
 *   1  any step failed
 *   2  missing required env vars
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BANGKOK_CONFIG, BANGKOK_REPORTS } from './lib/bangkok-data.mjs'

// ── env loading ──────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envPath   = path.resolve(__dirname, '../.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '')
  }
}

const BASE_URL = process.env.VITE_CMS_BASE_URL ?? 'https://api.cms.reearth.io'
const PROJECT  = process.env.VITE_CMS_PROJECT         // "workspace/project-alias"
const MODEL    = process.env.VITE_CMS_MODEL ?? 'damage-report'
const CONFIG_MODEL = process.env.VITE_CMS_CONFIG_MODEL ?? 'deployment-config'
// Prefer the non-VITE secret name (CMS_TOKEN) so the write token can never be
// picked up by a Vite client build; fall back to VITE_CMS_TOKEN for local .env.
const TOKEN    = process.env.CMS_TOKEN ?? process.env.VITE_CMS_TOKEN

if (!PROJECT || !TOKEN) {
  console.error('❌ VITE_CMS_PROJECT and CMS_TOKEN must be set.')
  console.error('   For GitHub Actions: add as repo secrets (already done).')
  console.error('   For local runs:     copy them into demo/.env.')
  process.exit(2)
}

const args = process.argv.slice(2)
const flags = {
  dryRun:        args.includes('--dry-run'),
  keepExisting:  args.includes('--keep-existing'),
  help:          args.includes('--help') || args.includes('-h'),
}

if (flags.help) {
  console.log(`Usage: node scripts/bootstrap-bangkok.mjs [--dry-run] [--keep-existing]`)
  process.exit(0)
}

const [WS, PROJ] = PROJECT.split('/')
const writeBase  = `${BASE_URL}/api/${WS}/projects/${PROJ}`
const readBase   = `${BASE_URL}/api/p/${PROJECT}`              // public read uses workspace/project as-is

const authHeaders = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

console.log(`📡 CMS:      ${BASE_URL}`)
console.log(`📦 Project:  ${PROJECT}`)
console.log(`🔑 Token:    ${TOKEN.slice(0, 8)}…`)
console.log(`⚙️  Mode:     ${flags.dryRun ? 'dry-run' : flags.keepExisting ? 'append' : 'replace'}\n`)

// ── helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms))
const toFields = obj => Object.entries(obj).map(([key, value]) => ({ key, value }))

/**
 * Map an index in [0, total-1] to an ISO timestamp linearly spread across
 * 06:00–18:00 UTC on 2026-10-14 — the Bangkok-flood scenario day. Gives the
 * 28 seeded reports a believable timeline rather than the same bootstrap-run
 * timestamp.
 */
function scenarioTimestamp (index, total) {
  // Month is 0-indexed in Date.UTC — 9 = October.
  const start = Date.UTC(2026, 9, 14,  6, 0, 0)
  const end   = Date.UTC(2026, 9, 14, 18, 0, 0)
  const ratio = total > 1 ? index / (total - 1) : 0
  return new Date(start + Math.floor((end - start) * ratio)).toISOString()
}

async function fetchJson (url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

/**
 * List all items in a model via the Integration API (includes drafts).
 * Re:Earth CMS sometimes returns `results`, sometimes `items` — accept both.
 */
async function listAllItems (model) {
  const url = `${writeBase}/models/${model}/items?perPage=200`
  const data = await fetchJson(url, { headers: authHeaders })
  return [...(data.results ?? []), ...(data.items ?? [])]
}

/**
 * Try a PATCH and return { ok, status, body }. Always logs the response body
 * so a 400 from Re:Earth CMS reveals which field key it rejected.
 */
async function rawPatch (model, itemId, fields) {
  const url = `${writeBase}/models/${model}/items/${itemId}`
  const res = await fetch(url, {
    method: 'PATCH', headers: authHeaders,
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ fields }),
  })
  const body = await res.text().catch(() => '')
  return { ok: res.ok, status: res.status, body }
}

async function publishItem (model, itemId) {
  const url = `${writeBase}/models/${model}/items/${itemId}/publish`
  const res = await fetch(url, {
    method: 'POST', headers: authHeaders,
    signal: AbortSignal.timeout(10000),
    body: '{}',
  })
  if (!res.ok) console.warn(`   ⚠ publish ${model}/${itemId} → ${res.status}`)
}

/**
 * Patch result. `ok` means at least one field landed. `denied` means the row
 * is read-only to this Integration token (Re:Earth CMS denies PATCH on items
 * that were originally created via the web UI rather than the API). The
 * caller treats `denied` as a soft warning, not a failure, because that case
 * is normally resolved by the user editing the row directly in the UI.
 */
async function patchItem (model, itemId, fields) {
  if (flags.dryRun) { console.log(`   [dry-run] PATCH ${model}/${itemId} (${fields.length} fields)`); return { ok: true, denied: false } }

  const bulk = await rawPatch(model, itemId, fields)
  if (bulk.ok) {
    await publishItem(model, itemId)
    return { ok: true, denied: false }
  }
  console.warn(`   ⚠ PATCH ${model}/${itemId} (bulk) → ${bulk.status}: ${bulk.body.slice(0, 200)}`)
  if (bulk.status !== 400) return { ok: false, denied: false }   // 401/403/404 won't get fixed by retry

  console.log(`   ↪ retrying field-by-field to identify the offender…`)
  let ok = 0, bad = 0, deniedCount = 0
  for (const f of fields) {
    const r = await rawPatch(model, itemId, [f])
    if (r.ok) { ok += 1; console.log(`     ✅ ${f.key}`) }
    else {
      bad += 1
      if (r.body.includes('operation denied')) deniedCount += 1
      console.log(`     ❌ ${f.key} → ${r.status}: ${r.body.slice(0, 120)}`)
    }
  }
  await publishItem(model, itemId)
  console.log(`   ↪ field-by-field result: ${ok} ok / ${bad} rejected`)
  // "Every field denied" is the Re:Earth-CMS-row-locked-to-UI pattern. Surface
  // it as denied (soft warning) so the caller can exit 0 without alarming
  // red text when the row was already updated by hand in the CMS UI.
  return { ok: ok > 0, denied: ok === 0 && deniedCount === fields.length }
}

async function deleteItem (model, itemId) {
  if (flags.dryRun) { console.log(`   [dry-run] DELETE ${model}/${itemId}`); return true }
  const url = `${writeBase}/models/${model}/items/${itemId}`
  const res = await fetch(url, {
    method: 'DELETE', headers: authHeaders,
    signal: AbortSignal.timeout(15000),
  })
  return res.ok
}

async function createItem (model, fields, asPublic = true) {
  if (flags.dryRun) { console.log(`   [dry-run] POST ${model}`); return true }
  const url = `${writeBase}/models/${model}/items`
  const res = await fetch(url, {
    method: 'POST', headers: authHeaders,
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ fields, status: asPublic ? 'public' : 'draft' }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.warn(`   ⚠ POST ${model} → ${res.status}: ${body.slice(0, 120)}`)
    return false
  }
  // POST sometimes leaves the item as draft — explicitly publish.
  const json = await res.json().catch(() => ({}))
  const newId = json.id
  if (newId) {
    const pubUrl = `${writeBase}/models/${model}/items/${newId}/publish`
    await fetch(pubUrl, {
      method: 'POST', headers: authHeaders,
      signal: AbortSignal.timeout(10000),
      body: '{}',
    }).catch(() => {})
  }
  return true
}

// ── step 1: deployment-config → Bangkok ──────────────────────────────────────

/**
 * @returns {Promise<'ok' | 'denied' | 'failed'>}
 *   'ok'     — at least one row was PATCHed and re-published successfully
 *   'denied' — row(s) exist but Re:Earth CMS denies API writes on them; the
 *              user must update via the web UI instead (already-correct
 *              rows fall into this bucket and require no further action)
 *   'failed' — listing failed, or some other hard error
 */
async function fixDeploymentConfig () {
  console.log('🛠️  Step 1: deployment-config → Bangkok')
  let configs
  try {
    configs = await listAllItems(CONFIG_MODEL)
  } catch (err) {
    console.warn(`   ⚠ Could not list ${CONFIG_MODEL}: ${err.message}`)
    return 'failed'
  }
  console.log(`   Found ${configs.length} existing deployment-config row(s)`)

  const fields = toFields(BANGKOK_CONFIG)

  if (configs.length === 0) {
    console.log('   No row found — creating a fresh Bangkok deployment-config')
    return (await createItem(CONFIG_MODEL, fields)) ? 'ok' : 'failed'
  }

  let anyOk = false, allDenied = true
  for (const c of configs) {
    const id = c.id
    // Integration API may return fields either as top-level keys (public-read
    // shape) or as a `fields: [{key, value}]` array (integration-read shape);
    // try both so the log shows the actual "before" value.
    const flat = Array.isArray(c.fields)
      ? Object.fromEntries(c.fields.map(f => [f.key, f.value]))
      : c
    const before = flat.scenario_label ?? flat.title ?? '(unknown)'
    const result = await patchItem(CONFIG_MODEL, id, fields)
    if (result.ok) {
      anyOk = true; allDenied = false
      console.log(`   ✅ ${id}  "${before}" → "${BANGKOK_CONFIG.scenario_label}"`)
    } else if (result.denied) {
      console.log(`   ⏭  ${id}  PATCH denied by CMS — row was likely created in the web UI`)
      console.log(`       Current value: "${before}"`)
      console.log(`       Expected:      "${BANGKOK_CONFIG.scenario_label}"`)
      if (before === BANGKOK_CONFIG.scenario_label) {
        console.log(`       ✓ already matches target — no further action needed`)
      } else {
        console.log(`       ⚠ Please edit this row directly in the Re:Earth CMS web UI.`)
      }
    } else {
      allDenied = false
      console.log(`   ❌ ${id}  "${before}" → PATCH failed (see warning above)`)
    }
  }
  if (anyOk)     return 'ok'
  if (allDenied) return 'denied'
  return 'failed'
}

// ── step 2: damage-report wipe + seed ────────────────────────────────────────

async function resetDamageReports () {
  console.log('\n🛠️  Step 2: damage-report → 28 Bangkok rows')

  let existing
  try {
    existing = await listAllItems(MODEL)
  } catch (err) {
    console.warn(`   ⚠ Could not list ${MODEL}: ${err.message}`)
    return false
  }
  console.log(`   Found ${existing.length} existing damage-report row(s)`)

  if (!flags.keepExisting) {
    console.log(`   Wiping legacy rows…`)
    let deleted = 0
    for (const item of existing) {
      const ok = await deleteItem(MODEL, item.id)
      if (ok) deleted += 1
      await sleep(150)
    }
    console.log(`   ✅ Deleted ${deleted}/${existing.length}`)
  } else {
    console.log(`   --keep-existing → leaving legacy rows in place`)
  }

  console.log(`   Seeding ${BANGKOK_REPORTS.length} Bangkok rows…`)
  let created = 0
  for (let i = 0; i < BANGKOK_REPORTS.length; i++) {
    // Stamp each report with a believable disaster-day timestamp so the
    // dashboard "Time" column reads as a timeline rather than as 28 rows
    // posted in the same second. We spread the rows linearly across
    // 06:00–18:00 UTC on 2026-10-14 (~25 min per report), matching the
    // typical first-12-hour reporting window of an urban flood event.
    const report = { ...BANGKOK_REPORTS[i], timestamp: scenarioTimestamp(i, BANGKOK_REPORTS.length) }
    const ok = await createItem(MODEL, toFields(report))
    if (ok) created += 1
    const tag = `[${String(i + 1).padStart(2, '0')}/${BANGKOK_REPORTS.length}]`
    console.log(`   ${ok ? '✅' : '❌'} ${tag} ${report.district} · ${report.tier} · ${report.timestamp.slice(11, 16)}`)
    await sleep(200)
  }
  console.log(`   ✅ Created ${created}/${BANGKOK_REPORTS.length}`)
  return created === BANGKOK_REPORTS.length
}

// ── main ─────────────────────────────────────────────────────────────────────

const t0 = Date.now()
const r1 = await fixDeploymentConfig()         // 'ok' | 'denied' | 'failed'
const r2 = await resetDamageReports()          // boolean
const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

const configLabel  = r1 === 'ok' ? 'ok' : r1 === 'denied' ? 'denied (UI-managed)' : 'FAIL'
const reportsLabel = r2 ? 'ok' : 'FAIL'
console.log(`\n🏁 Done in ${elapsed}s.  config=${configLabel}  reports=${reportsLabel}`)

if (r1 === 'denied' && r2) {
  console.log(`
ℹ️  The deployment-config row is read-only to this Integration token, so the
   script could not PATCH it. This is expected for rows created via the
   Re:Earth CMS web UI. If the row already shows Bangkok values on the live
   dashboard, no further action is needed. Otherwise edit it in the CMS UI:
   https://cms.reearth.io  →  Workspace  →  deployment-config  →  edit row
`)
}

// Success contract:
//   - config 'ok' or 'denied' counts as non-blocking, AND
//   - damage-reports updated successfully.
process.exit(r2 && r1 !== 'failed' ? 0 : 1)
