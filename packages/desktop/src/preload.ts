// Runs sandboxed and context-isolated: the page gets nothing but what is bridged here.
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('simcityDesktop', {
  platform: process.platform,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
});
