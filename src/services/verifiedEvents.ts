/**
 * Client-side fetcher for fused, webhook-sourced crisis events.
 *
 * Reads from a static JSON file at `<base>/verified-events.json` that the
 * `demo/scripts/fusion/run.mjs` script generates (and that GitHub Actions
 * keeps fresh on a cron). Falls back gracefully to an empty array if the
 * file is missing or malformed — the rest of the Dashboard keeps working.
 *
 * The same JSON shape is also what a future CMS read endpoint would
 * return, so swapping the source later is a one-function change.
 */

import type { FusedEvent } from '../types'

interface VerifiedEventsPayload {
  generatedAt: string
  eventCount: number
  events: FusedEvent[]
}

/**
 * Fetch all known verified (webhook-fused) crisis events.
 * Returns [] on any failure — never throws.
 */
export async function fetchVerifiedEvents(): Promise<FusedEvent[]> {
  // Use Vite's BASE_URL so this works under any /sub/path/ deployment
  // (we ship on GitHub Pages at /verified-crisis-mapper/demo/).
  const base = import.meta.env.BASE_URL ?? '/'
  const url  = `${base}verified-events.json`.replace(/\/+/g, '/')

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      cache:  'no-cache',  // always pick up fresh fusion output
    })
    if (!res.ok) {
      console.warn(`[verified-events] ${res.status} ${res.statusText} — returning []`)
      return []
    }
    const data = await res.json() as VerifiedEventsPayload
    if (!Array.isArray(data.events)) {
      console.warn('[verified-events] payload missing .events array — returning []')
      return []
    }
    console.info(`[verified-events] loaded ${data.events.length} event(s), generated ${data.generatedAt}`)
    return data.events
  } catch (err) {
    console.warn('[verified-events] fetch failed', err)
    return []
  }
}
