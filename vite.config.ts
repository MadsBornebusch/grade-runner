import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Installable, and opens offline: the app shell is precached and
    // everything the athlete has entered lives in localStorage. A new
    // version waits for "Reload" (ui/UpdatePrompt.tsx) rather than
    // reloading under a half-typed lap or check-in.
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        id: '/',
        name: 'Grade Runner',
        short_name: 'Grade Runner',
        description: 'Race pacing for hilly courses and a training plan from your runs.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#F5F3EE',
        theme_color: '#F5F3EE',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Today', url: '/#/today' },
          { name: 'Schedule', url: '/#/schedule' },
          { name: 'Progress', url: '/#/today/progress' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // /api is the server: Strava's OAuth callback is a top-level
        // navigation, and answering it with the app shell would drop the
        // session cookie. Nothing under it is cached either.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-css' },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 10, maxAgeSeconds: 365 * 24 * 3600 },
            },
          },
          {
            // Map tiles are opaque <img> responses, each counted at several
            // MB of quota, so only the most recent few are kept.
            urlPattern: ({ url }) => url.hostname.endsWith('tile.openstreetmap.org'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 60, maxAgeSeconds: 30 * 24 * 3600 },
            },
          },
        ],
      },
    }),
  ],
})
