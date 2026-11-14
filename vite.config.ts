import { defineConfig, type Plugin } from 'vite';
import path from 'node:path';

/**
 * The client is a vanilla-TS SPA with no framework runtime: it builds to a few
 * hashed assets and talks to the same origin under /api. In development, Vite
 * proxies /api to the Express server so cookies, SSE, and relative URLs all
 * behave exactly as they do in production.
 */
/**
 * The device build answers on the page instead of calling /api, so it is a
 * different bundle from the same source. Driven by an env var rather than a
 * runtime check: a constant cannot silently pick the wrong brain at runtime.
 *
 *   IDOL_DEVICE_BUILD=1 npm run build   → offline bundle for the Android shell
 */
const deviceBuild = process.env.IDOL_DEVICE_BUILD === '1';

/**
 * In the device build, syntax grammars must live in the one bundle.
 *
 * highlight.ts loads them with dynamic import() so the web build can skip
 * grammars nobody looks at. A WebView has the files on local disk already, so
 * nineteen extra requests cost more than the bytes: rewriting each loader to a
 * static import lets Rollup fold them into the single output file.
 */
function inlineLanguageGrammars(): Plugin {
  return {
    name: 'idol-inline-highlight-languages',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('lib/highlight.ts')) return null;
      const rewritten = code.replace(
        /:\s*\(\)\s*=>\s*import\('highlight\.js\/lib\/languages\/([a-z0-9]+)'\)/g,
        (_match, language: string) =>
          `: (() => Promise.resolve({ default: (window as unknown as { __idolGrammars: Record<string, unknown> }).__idolGrammars['${language}'] }))`,
      );
      if (rewritten === code) return null;
      const languages = [...code.matchAll(/languages\/([a-z0-9]+)'/g)].map((match) => match[1]);
      const unique = [...new Set(languages)];
      const imports = unique
        .map((language, index) => `import __grammar${index} from 'highlight.js/lib/languages/${language}';`)
        .join('\n');
      const map = unique.map((language, index) => `  ${language}: __grammar${index},`).join('\n');
      return `${imports}\n\n(window as unknown as { __idolGrammars: Record<string, unknown> }).__idolGrammars = {\n${map}\n};\n\n${rewritten}`;
    },
  };
}

const SERVER_ONLY = [/\/lib\/api\.ts$/];

/**
 * Keeps server-only code out of the device build entirely.
 *
 * The HTTP client, the repository-source dialog, and the file browser all exist
 * to talk to a backend. Aliasing them to a stub is stronger than relying on
 * tree-shaking or on lazy imports: Rollup is free to inline a dynamic import
 * into a single chunk, and a stray static import anywhere would then put fetch
 * calls back into the APK. With this, the code is not in the graph at all.
 *
 * Nothing can reach these at runtime either: the UI branches on IS_DEVICE_BUILD
 * before offering those screens.
 */
function excludeServerOnly(): Plugin {
  return {
    name: 'idol-exclude-server-only',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null;
      const resolved = path.resolve(path.dirname(importer), source);
      if (SERVER_ONLY.some((pattern) => pattern.test(resolved))) {
        return `\0idol-empty:${resolved}`;
      }
      return null;
    },
    load(id) {
      if (!id.startsWith('\0idol-empty:')) return null;
      // A Proxy that throws on any use: if a branch ever reaches this, the failure
      // is loud in development instead of a silent undefined.
      return `const fail = (name) => { throw new Error('Not available in the offline build: ' + name); };
export const api = new Proxy({}, { get: (_t, key) => () => fail(String(key)) });
export class ApiError extends Error { constructor(message) { super(message); this.name = 'ApiError'; this.code = 'offline_build'; this.status = 0; this.retryable = false; } }
export function openSourcesDialog() { fail('openSourcesDialog'); }
export function openFileBrowser() { fail('openFileBrowser'); }
`;
    },
  };
}

export default defineConfig({
  root: path.resolve(process.cwd(), 'web'),
  // Inside the APK the bundle is served at /assets/www/. A relative base makes
  // the emitted URLs resolve there instead of at the origin root, which is what
  // absolute /assets/... paths would do.
  base: deviceBuild ? './' : '/',
  plugins: deviceBuild ? [excludeServerOnly(), inlineLanguageGrammars()] : [],
  define: {
    __IDOL_DEVICE__: JSON.stringify(deviceBuild),
  },
  publicDir: path.resolve(process.cwd(), 'web/public'),
  build: {
    outDir: path.resolve(process.cwd(), deviceBuild ? 'dist-device' : 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
    assetsInlineLimit: 4096,
    modulePreload: deviceBuild ? false : { polyfill: true },
    rollupOptions: {
      // highlight.js loads language grammars with dynamic import(). On the web
      // that is a nice lazy-load; in a WebView it is 40 extra files to open.
      // Inlining them costs about 30 kB gzipped and saves that entirely.
      // The device build ships one bundle. highlight.js loads language grammars
      // with dynamic import(); on the web that is useful lazy-loading, in a
      // WebView it is forty extra files to open on a phone. Rollup will not allow
      // manualChunks and inlineDynamicImports together, so the device build has
      // neither and the web build keeps its split.
      output: deviceBuild
        ? {}
        : {
            manualChunks: {
              markdown: ['marked', 'dompurify'],
              highlight: ['highlight.js/lib/core'],
            },
          },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // The preview host is not localhost, so the proxy must not be restricted.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.IDOL_API_URL ?? 'http://127.0.0.1:8787',
        changeOrigin: false,
        ws: false,
        // SSE must not be buffered by the proxy.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
  esbuild: {
    target: 'es2020',
  },
});
