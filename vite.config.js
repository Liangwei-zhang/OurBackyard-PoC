import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: 'index-v2.html'
    }
  },
  server: {
    port: 3000,
    host: true
  },
  optimizeDeps: {
    include: ['dexie', 'h3-js']
  }
});
