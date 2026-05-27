/**
 * Re:Earth CMS connection config.
 * Values are read from VITE_* env vars (baked in at build time by Vite).
 * To run locally: copy .env.example → .env and fill in your values.
 */
export const CMS = {
  baseUrl: import.meta.env.VITE_CMS_BASE_URL as string | undefined,
  project: import.meta.env.VITE_CMS_PROJECT as string | undefined,
  model:   import.meta.env.VITE_CMS_MODEL   as string | undefined,
  // SECURITY: VITE_* vars are baked into the public client bundle. A write
  // token must NEVER be injected into the deployed build (it would be visible
  // to anyone who downloads the JS). The GitHub Pages workflow deliberately
  // omits it, so `token` is undefined in production and the app runs read-only.
  // This var is only populated for LOCAL development via demo/.env (gitignored),
  // where the bundle is never published. Server-side writes use the CMS_TOKEN
  // secret in the bootstrap-cms / auto-publish-cms workflows.
  token:   import.meta.env.VITE_CMS_TOKEN   as string | undefined,

  /** True only when all three required read-path vars are present */
  get enabled() {
    return !!(this.baseUrl && this.project && this.model)
  },

  /** True when a write token is also provided */
  get writable() {
    return this.enabled && !!this.token
  },
} as const
