import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Built assets are served by the FastAPI backend: dist/ is mounted at /static
// and dist/index.html is returned at the root URL, matching the legacy layout.
export default defineConfig({
  plugins: [react()],
  base: '/static/',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
})
