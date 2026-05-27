import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/verified-crisis-mapper-demo/',
  build: {
    outDir: 'dist',
  },
})
