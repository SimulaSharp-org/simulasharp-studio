import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// base './' → relative asset URLs, so the built SPA works when served from the Host's wwwroot.
export default defineConfig({
  base: './',
  plugins: [react()],
})
