import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Deployed as a GitHub Pages project site (https://<user>.github.io/ref-app/),
// so built asset URLs need the repo name as a base path.
export default defineConfig({
  base: '/ref-app/',
  plugins: [react()],
});
