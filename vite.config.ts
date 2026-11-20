import { defineConfig } from 'vite';

// The built app is served by the vault server (from its releases folder) under /app/, so asset paths are relative and
// the API is the same origin. `npm run dev` proxies /api to a vault: VAULT_URL, or one running locally.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

export default defineConfig(({ command }) => ({
  base: './',
  server: {
    proxy: { '/api': { target: process.env.VAULT_URL ?? 'http://127.0.0.1:8787', changeOrigin: true } },
  },
  build: { outDir: 'dist', assetsInlineLimit: 0, sourcemap: false },
  plugins: [
    {
      name: 'csp',
      // Only in the build: the dev server injects inline scripts of its own.
      transformIndexHtml: (html: string) =>
        command === 'build' ? html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`) : html,
    },
  ],
}));
