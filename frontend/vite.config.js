import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backendTarget = process.env.FOXOS_DEV_BACKEND || 'http://localhost:3001'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest) => {
            proxyRequest.setHeader('Origin', backendTarget)
          })
        },
      },
    },
  },
})
