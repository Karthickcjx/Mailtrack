import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { apiHostPattern, buildManifest } from './manifest.base';

const here = import.meta.dirname;

function manifestPlugin(env: Record<string, string>, apiBase: string): Plugin {
  return {
    name: 'tracklet-manifest',
    generateBundle() {
      const keyFile = JSON.parse(readFileSync(resolve(here, 'manifest.key.json'), 'utf8')) as { key: string };
      const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8')) as { version?: string };
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(buildManifest({ key: keyFile.key, oauthClientId: env.TRACKLET_OAUTH_CLIENT_ID, version: pkg.version ?? '0.0.1', apiBase }), null, 2),
      });
    },
  };
}

/** Content scripts cannot be ES modules: bundle content.ts separately as one self-contained IIFE. */
function contentScriptPlugin(mode: string): Plugin {
  return {
    name: 'tracklet-content-script',
    async generateBundle() {
      const r = await esbuild({
        entryPoints: [resolve(here, 'src/content.ts')],
        bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false,
        minify: mode !== 'development', sourcemap: mode === 'development' ? 'inline' : false, legalComments: 'none',
      });
      this.emitFile({ type: 'asset', fileName: 'content.js', source: r.outputFiles[0]!.text });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here, 'TRACKLET_');
  const apiBase = (env.TRACKLET_API_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  apiHostPattern(apiBase);   // fail the build on a non-https / non-origin API base
  if (mode === 'release' && (!apiBase.startsWith('https://') || !env.TRACKLET_OAUTH_CLIENT_ID)) {
    throw new Error('release build needs TRACKLET_API_BASE=https://… and TRACKLET_OAUTH_CLIENT_ID in extension/.env.release.local (run npm run preflight)');
  }
  return {
    root: resolve(here, 'src'),
    publicDir: resolve(here, 'public'),
    plugins: [manifestPlugin(env, apiBase), contentScriptPlugin(mode)],
    define: { __API_BASE__: JSON.stringify(apiBase) },
    build: {
      outDir: resolve(here, 'dist'),
      emptyOutDir: true,
      sourcemap: mode === 'development',
      rollupOptions: {
        input: {
          background: resolve(here, 'src/background.ts'),
          popup: resolve(here, 'src/popup.html'),
          dashboard: resolve(here, 'src/dashboard.html'),
        },
        output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name].js', assetFileNames: 'assets/[name][extname]' },
      },
    },
  };
});
