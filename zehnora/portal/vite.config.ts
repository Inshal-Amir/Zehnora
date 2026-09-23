import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Dev: same-origin proxy to the platform API so session cookies and CSRF work as in production
// (console.<domain> serves the portal and /platform/v1 from one origin).
const api = process.env.ZEHNORA_PLATFORM_URL ?? 'http://127.0.0.1:8200';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@brand': fileURLToPath(new URL('../brand', import.meta.url)) } },
  server: {
    fs: { allow: ['..'] },
    proxy: { '/platform': api, '/v1': api },
  },
  build: { outDir: 'dist', sourcemap: false },
});
