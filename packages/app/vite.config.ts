import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// SharedArrayBuffer needs a cross-origin isolated page: COOP same-origin + COEP require-corp.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true, headers: crossOriginIsolation },
  preview: { port: 5174, strictPort: true, headers: crossOriginIsolation },
  worker: { format: 'es' },
});
