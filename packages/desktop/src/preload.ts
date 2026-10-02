// Runs sandboxed and context-isolated: the page gets nothing but what is bridged here.
import { contextBridge, ipcRenderer } from 'electron';

// The channels of src/saves.ts (SAVE_CHANNELS), repeated: a sandboxed preload cannot load `node:fs`.
// Each call passes the slot number (and a save's bytes) only; the main process checks the number.
contextBridge.exposeInMainWorld('simcityDesktop', {
  platform: process.platform,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  save: (slot: number, bytes: ArrayBuffer) => ipcRenderer.invoke('simcity:saves:save', slot, bytes),
  load: (slot: number) => ipcRenderer.invoke('simcity:saves:load', slot),
  list: () => ipcRenderer.invoke('simcity:saves:list'),
  remove: (slot: number) => ipcRenderer.invoke('simcity:saves:remove', slot),
});
