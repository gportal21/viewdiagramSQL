import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * libpg-query (el parser real de PostgreSQL compilado a WASM) localiza su
 * archivo .wasm en tiempo de ejecución con `locateFile`. Lo reescribimos como
 * `new URL('./libpg-query.wasm', import.meta.url)` para que Vite lo detecte,
 * lo copie a /assets y genere la URL correcta tanto en dev como en build.
 */
function pgQueryWasm(): Plugin {
  return {
    name: 'pg-query-wasm',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('libpg-query') || !id.endsWith('libpg-query.js')) return null;
      const needle = 'function findWasmBinary(){return locateFile("libpg-query.wasm")}';
      if (!code.includes(needle)) return null;
      return code.replace(
        needle,
        'function findWasmBinary(){return new URL("./libpg-query.wasm", import.meta.url).href}',
      );
    },
  };
}

export default defineConfig({
  // Rutas relativas: funciona en GitHub Pages (/viewdiagramSQL/) y en local.
  base: './',
  plugins: [pgQueryWasm(), react()],
  optimizeDeps: {
    // Si Vite pre-empaqueta libpg-query, el .wasm deja de estar junto al JS.
    exclude: ['libpg-query'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('elkjs')) return 'elk';
          if (id.includes('libpg-query') || id.includes('pgsql-deparser') || id.includes('@pgsql')) return 'pg-parser';
          if (id.includes('@codemirror') || id.includes('@lezer') || id.includes('@uiw')) return 'editor';
          if (id.includes('@xyflow') || id.includes('d3-')) return 'flow';
          return 'vendor';
        },
      },
    },
  },
  worker: { format: 'es' },
});
