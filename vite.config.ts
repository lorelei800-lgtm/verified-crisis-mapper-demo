import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'

// `command` is 'serve' for `npm run dev`, 'build' for `npm run build`.
// basic-ssl gives the dev server a self-signed HTTPS certificate so a phone
// on the same Wi-Fi (reached via `npm run dev -- --host`) gets a "secure
// context" — required by mobile browsers for camera + geolocation in the
// Reporter flow. It is applied only in dev; production builds are unaffected.
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    ...(command === 'serve' ? [basicSsl()] : []),
    // PWA: makes the app installable and able to launch offline (matches the
    // proposal's "installable / offline-first" claims). The service worker is
    // generated only for the production build; dev is left untouched so local
    // iteration has no SW caching surprises.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      // Keep the existing hand-written public/manifest.json and icons — the
      // plugin only adds the service worker, it does not regenerate a manifest.
      manifest: false,
      devOptions: { enabled: false },
      workbox: {
        // Precache the app shell only. Exclude the webhook dataset so fresh
        // events are always fetched from the network, not a stale cache.
        globPatterns: ['**/*.{js,css,html,ico,svg,png,woff2}'],
        globIgnores: ['**/verified-events.json'],
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // Live CMS reads — always try the network first, fall back to the
            // last response only when offline.
            urlPattern: ({ url }) => url.origin === 'https://api.cms.reearth.io',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'cms-api',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Webhook-fused events JSON — same network-first policy.
            urlPattern: ({ url }) => url.pathname.endsWith('verified-events.json'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'verified-events',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  base: '/verified-crisis-mapper-demo/',
  build: {
    outDir: 'dist',
  },
}))
