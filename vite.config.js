import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    allowedHosts: ['ourbackyard.ngrok.app'],
    host: '0.0.0.0',
    port: 6060
  }
})