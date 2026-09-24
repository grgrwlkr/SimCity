// `window.__sim` for DevTools and Playwright. main.tsx imports this module only under `__SIM_API__`
// (packages/app/vite.config.ts): a release build carries neither the module nor the name.
import type { SimApi } from './simApi';

export function installSimApi(api: SimApi): void {
  window.__sim = api;
}
