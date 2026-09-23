// electron-builder afterPack hook (package.json `build.afterPack`): flips the Electron fuses of the
// packed SimCity.app. Runs after electron-builder wrote Info.plist (ElectronAsarIntegrity included),
// so the asar integrity fuse has a hash to check. The build is unsigned (`mac.sign: null`), but an
// arm64 binary must carry at least an ad-hoc signature, which flipping bytes breaks: the ad-hoc
// signature is redone. Fuse semantics: https://www.electronjs.org/docs/latest/tutorial/fuses
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses';
import path from 'node:path';

/** @param {{ appOutDir: string, electronPlatformName: string, packager: { appInfo: { productFilename: string } } }} context */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    throw new Error(`after-pack: fuses are wired for macOS only, got ${context.electronPlatformName}`);
  }
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await flipFuses(app, {
    version: FuseVersion.V1,
    // A fuse added by a future Electron fails the build until it is decided here.
    strictlyRequireAllFuses: true,
    resetAdHocDarwinSignature: true,
    [FuseV1Options.RunAsNode]: false,
    // On macOS cookie encryption goes through the Keychain and can raise a system prompt; the game
    // keeps no cookies.
    [FuseV1Options.EnableCookieEncryption]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    // The page is served from app://bundle, never from file://.
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true,
  });
}
