/**
 * Vite config for building the P2P SDK adapter as a browser-compatible IIFE.
 *
 * Output: js/ob-sdk.js
 *
 * Usage:
 *   npm run build:sdk
 */
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'js',
    emptyOutDir: false,  // don't wipe js/ — it has other files
    lib: {
      entry:    resolve(__dirname, 'app/p2p-adapter.js'),
      name:     'OBP2P',           // global exposed only as window.OurBackyardMesh (set inside adapter)
      fileName: 'ob-sdk',
      formats:  ['iife'],
    },
    minify: 'esbuild',
    sourcemap: false,
    rollupOptions: {
      // All deps are bundled — no externals (the adapter imports SDK internals)
      external: [],
      output: {
        // Rename from ob-sdk.iife.js to ob-sdk.js
        entryFileNames: 'ob-sdk.js',
      },
    },
  },
  // Resolve SDK modules relative to project root
  resolve: {
    alias: {},
  },
});
