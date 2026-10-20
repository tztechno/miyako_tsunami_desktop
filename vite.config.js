import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5174, open: false, watch: { ignored: ['**/.cache/**', '**/src-tauri/**'] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
