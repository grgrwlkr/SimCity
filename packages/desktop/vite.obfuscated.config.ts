// Optional obfuscation of the current city's modules. Vendors and page entry points remain separate;
// the archived game is not included in either build.
import JavaScriptObfuscator from 'javascript-obfuscator';
import {defineConfig, mergeConfig, type Plugin} from 'vite';
import appConfig from '../app/vite.config';

const UI_CHUNK = 'ui';
// Both entries have DOM side effects: a shared chunk must never boot the other page.
const UI_MODULE = /\/packages\/app\/src\/(?!main\.ts$|city\/main\.ts$).*\.ts$/;
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
    if (chunk.name !== UI_CHUNK) {
      return null;
    }

    // Rolldown's own helpers are virtual (`\0…`); anything else outside app/ui must not be obfuscated.
    const foreign = chunk.moduleIds.filter(
      id => !id.startsWith('\0') && !UI_MODULE.test(id),
    );

    if (foreign.length > 0) {
      this.error(
        `the ${UI_CHUNK} chunk holds modules outside the current app: ${foreign.join(', ')}`,
      );
    }

    return {
      code: JavaScriptObfuscator.obfuscate(code, OPTIONS).getObfuscatedCode(),
      map: null,
    };
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
              {name: 'vendor', test: VENDOR_MODULE},
              // Without `includeDependenciesRecursively: false` the group swallows everything app and ui import.
              {
                name: UI_CHUNK,
                test: UI_MODULE,
                includeDependenciesRecursively: false,
              },
            ],
          },
        },
      },
    },
  }),
);
