import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// `command` is 'serve' for `npm run dev`, 'build' for `npm run build`.
// basic-ssl gives the dev server a self-signed HTTPS certificate so a phone
// on the same Wi-Fi (reached via `npm run dev -- --host`) gets a "secure
// context" — required by mobile browsers for camera + geolocation in the
// Reporter flow. It is applied only in dev; production builds are unaffected.
export default defineConfig(({ command }) => ({
  plugins: [react(), ...(command === 'serve' ? [basicSsl()] : [])],
  base: '/verified-crisis-mapper-demo/',
  build: {
    outDir: 'dist',
  },
}))
