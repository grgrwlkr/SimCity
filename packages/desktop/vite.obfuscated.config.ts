// `bun run desktop:build:obfuscated`: the app's own Vite build, with the modules of packages/app and
// packages/ui in a chunk of their own and only that chunk run through javascript-obfuscator. The
// simulation, the bridge and the renderer stay plain: obfuscated code is 15–80 % slower (README of
// the obfuscator), which the hot path cannot afford. The worker bundle gets no plugins from here.
import JavaScriptObfuscator from 'javascript-obfuscator';
import { defineConfig, mergeConfig, type Plugin } from 'vite';
import appConfig from '../app/vite.config';

const UI_CHUNK = 'ui';
// The entry `main.tsx` stays out: it calls the bridge at the top level, and a `ui` chunk holding it
// would evaluate before the chunk it imports from ("a is not a function" in both engines, measured).
const UI_MODULE = /\/packages\/(ui\/src\/|app\/src\/(?!main\.tsx))/;
const VENDOR_MODULE = /\/node_modules\//;

const OPTIONS = {
  ...JavaScriptObfuscator.getOptionsByPreset('low-obfuscation'),
  // The preset silences `console` for the whole page, the simulation's reports included.
  disableConsoleOutput: false,
};

const obfuscateUiChunk: Plugin = {
  name: 'obfuscate-ui-chunk',
  apply: 'build',
  renderChunk(code, chunk) {
    if (chunk.name !== UI_CHUNK) return null;
    // Rolldown's own helpers are virtual (`\0…`); anything else outside app/ui must not be obfuscated.
    const foreign = chunk.moduleIds.filter((id) => !id.startsWith('\0') && !UI_MODULE.test(id));
    if (foreign.length > 0) this.error(`the ${UI_CHUNK} chunk holds modules outside packages/app and packages/ui: ${foreign.join(', ')}`);
    return { code: JavaScriptObfuscator.obfuscate(code, OPTIONS).getObfuscatedCode(), map: null };
  },
};

export default mergeConfig(
  appConfig,
  defineConfig({
    plugins: [obfuscateUiChunk],
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              // Libraries apart, so the ui chunk and the entry chunk do not import each other's CommonJS wrappers.
              { name: 'vendor', test: VENDOR_MODULE },
              // Without `includeDependenciesRecursively: false` the group swallows everything app and ui import.
              { name: UI_CHUNK, test: UI_MODULE, includeDependenciesRecursively: false },
            ],
          },
        },
      },
    },
  }),
);
