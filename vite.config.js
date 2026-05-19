import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  // Local dev: proxy /mm-api/* to Mobile Message with Basic auth injected
  // server-side. Browser can't hit api.mobilemessage.com.au directly (no CORS
  // headers), so we tunnel through Vite. Production uses /api/mm-* Vercel
  // functions instead, so this proxy is dev-only.
  const mmAuth =
    env.VITE_MM_USERNAME && env.VITE_MM_API_PASSWORD
      ? 'Basic ' + Buffer.from(`${env.VITE_MM_USERNAME}:${env.VITE_MM_API_PASSWORD}`).toString('base64')
      : null

  return {
    plugins: [react()],
    build: { outDir: 'dist' },
    server: {
      proxy: {
        '/mm-api': {
          target: 'https://api.mobilemessage.com.au',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/mm-api/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (mmAuth) proxyReq.setHeader('Authorization', mmAuth)
            })
          },
        },
      },
    },
  }
})
