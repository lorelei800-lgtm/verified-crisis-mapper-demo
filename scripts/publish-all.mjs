/**
 * publish-all.mjs — Publish all draft items in Re:Earth CMS
 *
 * Usage (from demo/ directory):
 *   node scripts/publish-all.mjs
 *
 * Reads credentials from demo/.env
 * Requires Node 18+ (built-in fetch).
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// ── Load .env ────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envPath   = path.resolve(__dirname, '../.env')

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/)
    if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
}

const BASE_URL = process.env.VITE_CMS_BASE_URL
const PROJECT  = process.env.VITE_CMS_PROJECT   // "workspace/project"
const MODEL    = process.env.VITE_CMS_MODEL
const TOKEN    = process.env.VITE_CMS_TOKEN

if (!BASE_URL || !PROJECT || !MODEL || !TOKEN) {
  console.error('❌ Missing env vars. Check .env for VITE_CMS_BASE_URL, VITE_CMS_PROJECT, VITE_CMS_MODEL, VITE_CMS_TOKEN')
  process.exit(1)
}

const [WS, PROJ] = PROJECT.split('/')

// ── Fetch all items via Integration API (returns drafts too) ─────────────────
async function fetchAllItems() {
  let page = 1
  const all = []

  while (true) {
    const url = `${BASE_URL}/api/${WS}/projects/${PROJ}/models/${MODEL}/items?perPage=100&page=${page}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })
    if (!res.ok) {
      console.error(`❌ Fetch failed: ${res.status} ${res.statusText}`)
      process.exit(1)
    }
    const data = await res.json()
    const items = data.items ?? data.results ?? []
    all.push(...items)
    console.log(`  Page ${page}: ${items.length} items (total so far: ${all.length} / ${data.totalCount ?? '?'})`)
    if (all.length >= (data.totalCount ?? 0) || items.length === 0) break
    page++
  }
  return all
}

// ── Publish one item ──────────────────────────────────────────────────────────
async function publishItem(itemId) {
  const url = `${BASE_URL}/api/${WS}/projects/${PROJ}/models/${MODEL}/items/${itemId}/publish`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  return res.ok
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log(`\n🔍 Fetching all items from Re:Earth CMS...`)
console.log(`   ${BASE_URL}/api/${WS}/projects/${PROJ}/models/${MODEL}/items\n`)

const items = await fetchAllItems()
console.log(`\n📋 Total items found: ${items.length}`)

const drafts = items.filter(i => i.status !== 'public')
const already = items.filter(i => i.status === 'public')
console.log(`   ✅ Already public: ${already.length}`)
console.log(`   📝 Drafts to publish: ${drafts.length}\n`)

if (drafts.length === 0) {
  console.log('🎉 All items are already published!')
  process.exit(0)
}

let ok = 0, fail = 0
for (const item of drafts) {
  process.stdout.write(`  Publishing ${item.id} (status: ${item.status ?? 'unknown'}) ... `)
  const success = await publishItem(item.id)
  if (success) {
    ok++
    console.log('✅')
  } else {
    fail++
    console.log('❌')
  }
  // Small delay to avoid rate limiting
  await new Promise(r => setTimeout(r, 200))
}

console.log(`\n🏁 Done: ${ok} published, ${fail} failed`)
if (fail > 0) console.log('   ⚠️  Some items failed — check your token permissions')
