import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5341,
    proxy: {
      '/api': 'http://127.0.0.1:5340',
      '/auth': 'http://127.0.0.1:5340',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
