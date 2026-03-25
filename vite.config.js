import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: 'index.html'
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
