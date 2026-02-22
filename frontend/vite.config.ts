import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiBasePath = env.VITE_API_BASE_PATH || '/api'
  const apiTarget = env.VITE_API_TARGET || 'http://127.0.0.1:8000'

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: Number(env.VITE_DEV_PORT || 5173),
      proxy: {
        [apiBasePath]: {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (path) => {
            if (!path.startsWith(apiBasePath)) {
              return path
            }
            const rewritten = path.slice(apiBasePath.length)
            return rewritten.startsWith('/') ? rewritten : `/${rewritten}`
          },
        },
      },
    },
  }
})
