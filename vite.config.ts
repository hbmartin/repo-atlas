import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const siteUrl = new URL(env.VITE_SITE_URL || 'https://haroldmartin.me')
  if (!['https:', 'http:'].includes(siteUrl.protocol) || siteUrl.username || siteUrl.password
    || siteUrl.pathname !== '/' || siteUrl.search || siteUrl.hash) {
    throw new Error('VITE_SITE_URL must be an HTTP(S) origin, such as https://haroldmartin.me')
  }

  return {
    define: {
      'import.meta.env.VITE_SITE_URL': JSON.stringify(siteUrl.origin),
    },
    plugins: [
      react(),
      babel({ presets: [reactCompilerPreset()] })
    ],
  }
})
