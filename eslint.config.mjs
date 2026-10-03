import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', 'node_modules/**', '.astro/**', '.sites-runtime/**', '.wrangler/**', 'crates/**/pkg/**', 'crates/**/target/**', 'public/wasm/**', 'app/**', 'components/**', 'db/**', 'hooks/**', 'scripts/**', 'build/**', 'vite.config.ts', 'next.config.ts', 'drizzle.config.ts', 'cloudflare-env.d.ts'] },
  { languageOptions: { globals: { URL: 'readonly', AbortController: 'readonly', queueMicrotask: 'readonly', setTimeout: 'readonly' } } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
];
