import { defineConfig } from 'vite';

// Dev-only playground for playtesting games/games/* directly in the browser
// (no wallet, no backend). Not part of the production build pipeline.
export default defineConfig({
  root: 'playground',
  server: {
    port: 5183,
    strictPort: true,
  },
});
