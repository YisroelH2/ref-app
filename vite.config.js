import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// This same build is deployed to two places with different URL structures:
//   - GitHub Pages, as a project site at https://<user>.github.io/ref-app/
//     (needs the repo name as a base path).
//   - Cloudflare Pages, at the domain root https://ykp-refs.pages.dev/
//     (needs base '/' — Cloudflare Pages sets CF_PAGES=1 during its builds,
//     so we use that to tell the two apart automatically).
export default defineConfig({
  base: process.env.CF_PAGES ? '/' : '/ref-app/',
  plugins: [react()],
});
