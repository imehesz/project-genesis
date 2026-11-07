import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Production lives at https://mehesz.net/games/project-genesis/ ; dev stays at the root.
 * Override with BASE_PATH=/somewhere/else/ npm run build.
 */
export default defineConfig(({ command, isPreview }) => ({
  plugins: [react()],
  base: command === 'build' || isPreview ? (process.env.BASE_PATH ?? '/games/project-genesis/') : '/',
}));
