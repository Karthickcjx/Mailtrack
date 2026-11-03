import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { buildManifest } from './manifest.base';

function manifestPlugin(mode: string): Plugin {
  return {
    name: 'tracklet-manifest',
    generateBundle() {
      const keyFile = JSON.parse(readFileSync(resolve(import.meta.dirname, 'manifest.key.json'), 'utf8')) as { key: string };
      const env = loadEnv(mode, import.meta.dirname, 'TRACKLET_');
      const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as { version?: string };
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(
          buildManifest({ key: keyFile.key, oauthClientId: env.TRACKLET_OAUTH_CLIENT_ID, version: pkg.version ?? '0.0.1' }),
          null,
          2,
        ),
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  root: resolve(import.meta.dirname, 'src'),
  plugins: [manifestPlugin(mode)],
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: mode === 'development',
    rollupOptions: {
      input: {
        background: resolve(import.meta.dirname, 'src/background.ts'),
        popup: resolve(import.meta.dirname, 'src/popup.html'),
      },
      output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name].js', assetFileNames: 'assets/[name][extname]' },
    },
  },
}));
