# Q8 и Q9 из «Открытых вопросов» остатка — по живым источникам

Ответы на вопросы 8 и 9 из `docs/plans/2026-09-15-web-remaining-work.md` («Открытые вопросы»). Всё проверено 2026-09-21; версии взяты из файлов репозитория, не по памяти.

## Версии, к которым относятся ответы

| Что | Версия | Где закреплено (проверено 2026-09-21) |
|---|---|---|
| three | `0.185.1` | `/Users/xawkay/Develop/SimCity/package.json:24` → `"three": "0.185.1"`; `bun.lock:916` → `"three": ["three@0.185.1", "", {}, "sha512-5aojFCXKwnjBRZvUnt3WFfEcvUJgkN5LlijRFN95hMy8WVkG4I0QNcJE+OuWvuJ0bOdStrbfXn0pkd6/QyiAlg=="]` |
| @types/three | `0.185.4` | `package.json:34` |
| electron | `44.3.0` | `/Users/xawkay/Develop/SimCity/packages/desktop/package.json` → `"electron": "44.3.0"` |
| electron-builder | `26.15.3` | `packages/desktop/package.json` → `"electron-builder": "26.15.3"`; `bun.lock:448` → `"electron-builder": ["electron-builder@26.15.3", … sha512-a1KM5heqS3gQCZzizXEI8RjJy3QVogULPdeSknt76uLDpBIW/HDGsMg/XgP0riP6PI9COsRvFITKKGDqA8fJxA=="]` |

**Сопоставление npm-версии three с тегом git.** В `mrdoob/three.js` нет тега `r185.1`; последние теги — `r186`, `r185` (sha `2431a09f46f34c560bc8e44b33be0e567723d5b9`), `r184`… Метаданные npm для ровно `0.185.1` дают тот же коммит:

```
$ curl -sS https://registry.npmjs.org/three/0.185.1 | … print(version, gitHead, shasum)
0.185.1 2431a09f46f34c560bc8e44b33be0e567723d5b9 63e9e241a17b101e211965121a017b4b4d8054ae
```

`gitHead` пакета `0.185.1` побайтово равен sha тега `r185`, поэтому всё ниже цитируется по `raw.githubusercontent.com/mrdoob/three.js/r185/...` и относится именно к закреплённой версии. Уверенность: высокая.

**Ограничение проверки:** `node_modules` в рабочей копии отсутствует (`ls node_modules` → пусто, `find . -name three -path '*node_modules*'` → ничего), поэтому установленный пакет прочитать было нельзя; источником стал tarball/тег той же версии.

---

## Q8 · Пост-обработка WebGPURenderer на бэкенде WebGL2 (three 0.185.1)

### Что проверено

1. `src/renderers/webgpu/WebGPURenderer.js` тега `r185` — механика выбора бэкенда.
2. `examples/jsm/tsl/display/GTAONode.js`, `BloomNode.js`, `FXAANode.js`, `examples/jsm/csm/CSMShadowNode.js` тега `r185` — что из WebGPU-только эти узлы используют.
3. `src/renderers/webgl-fallback/WebGLBackend.js` тега `r185` — какие возможности бэкенд объявляет неподдерживаемыми.
4. `test/e2e/puppeteer.js` и `examples/files.json` тега `r185` — собственные скриншотные ворота three.js в headless-режиме и список исключённых примеров.
5. `playwright.config.ts` и `packages/render/src/debugRenderer.ts` репозитория — как ворота запускаются здесь.

### Вывод в одну строку

**Ни один из четырёх узлов не использует ничего, что бэкенд WebGL2 не умеет, поэтому R3 в принципе гоняется без `E2E_GPU=1`; единственное место с документированным риском — GTAO: сам three.js исключил свой пример `webgpu_postprocessing_ao` из headless-скриншотов с пометкой «Black screen», так что скриншотный пин GTAO стоит закрепить под `E2E_GPU=1`, а под SwiftShader проверять только «не упало».** Уверенность: средняя для GTAO, высокая для bloom / FXAA / CSM.

### Откат на WebGL2 — документирован и автоматический

`src/renderers/webgpu/WebGPURenderer.js`, строки 21–24 (JSDoc, из которого делается документация):

> ```
> /**
>  * This renderer is the new alternative of `WebGLRenderer`. `WebGPURenderer` has the ability
>  * to target different backends. By default, the renderer tries to use a WebGPU backend if the
>  * browser supports WebGPU. If not, `WebGPURenderer` falls backs to a WebGL 2 backend.
>  */
> ```

Строки 65–71 — сам откат:

> ```
> 			parameters.getFallback = () => {
>
> 				warn( 'WebGPURenderer: WebGPU is not available, running under WebGL2 backend.' );
>
> 				return new WebGLBackend( parameters );
>
> 			};
> ```

Ссылка: https://raw.githubusercontent.com/mrdoob/three.js/r185/src/renderers/webgpu/WebGPURenderer.js (проверено 2026-09-21).

Репозиторий на это и опирается — `packages/render/src/debugRenderer.ts:150,153,167`:

> ```
>   /** WebGPU where the browser has it, WebGL2 otherwise (three picks the backend). */
>     const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
>     return (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true ? 'WebGPU' : 'WebGL2';
> ```

### Bloom, FXAA, GTAO: WebGPU-только возможностей нет

Поиск по трём файлам тега `r185` (`grep -n -i 'compute|storage|isWebGPU|webgl|isAvailable|textureStore|workgroup|sampleCompare'`) даёт в `BloomNode.js` и `FXAANode.js` **ноль** совпадений, а в `GTAONode.js` только два — и оба в прозе, а не в коде:

```
149:		 * How many samples are used to compute the AO.
526: * Computes an array of magic square values required to generate the noise texture.
```

То есть все три узла — обычные фрагментные проходы по `QuadMesh`: ни compute-шейдеров, ни storage-буферов, ни `textureStore`. Импорты это подтверждают:

- `BloomNode.js:1` → `import { HalfFloatType, RenderTarget, Vector2, Vector3, TempNode, QuadMesh, NodeMaterial, RendererUtils, NodeUpdateType } from 'three/webgpu';`
- `FXAANode.js:1` → `import { Vector2, TempNode } from 'three/webgpu';`
- `GTAONode.js:1` → `import { DataTexture, RenderTarget, RepeatWrapping, Vector2, Vector3, TempNode, QuadMesh, NodeMaterial, RendererUtils, RedFormat } from 'three/webgpu';`

Требования к форматам целей рендера, которые надо держать в голове:

- bloom пишет в half-float: `BloomNode.js:155` → `this._renderTargetBright = new RenderTarget( 1, 1, { depthBuffer: false, type: HalfFloatType } );` (то же в строках 163 и 170). На WebGL2 это `EXT_color_buffer_float` / `EXT_color_buffer_half_float`.
- GTAO пишет в одноканальную цель: `GTAONode.js:97` → `this._aoRenderTarget = new RenderTarget( 1, 1, { depthBuffer: false, format: RedFormat } );`
- GTAO требует MRT со сценой — из его же JSDoc (`GTAONode.js:16–28`): `scenePass.setMRT( mrt( { output: output, normal: normalView } ) );` и `const scenePassDepth = scenePass.getTextureNode( 'depth' );`

`WebGLBackend.js` тега `r185` объявляет неподдерживаемым ровно одно, и это не про пост-обработку (строка 282):

> `warn( 'WebGPURenderer: Unable to use reversed depth buffer due to missing EXT_clip_control extension. Fallback to default depth buffer.' );`

Он даже умеет compute (через transform feedback): `WebGLBackend.js:887` → `compute( computeGroup, computeNode, bindings, pipeline, count = null ) {`, `1705` → `createComputePipeline( computePipeline, bindings ) {`. Ссылка: https://raw.githubusercontent.com/mrdoob/three.js/r185/src/renderers/webgl-fallback/WebGLBackend.js

### Каскадные тени: WebGL2-бэкенд учтён явно

`examples/jsm/csm/CSMShadowNode.js:41–42`:

> ```
>  * This module can only be used with {@link WebGPURenderer}. When using {@link WebGLRenderer},
>  * use {@link CSM} instead.
> ```

Это про **старый** `WebGLRenderer`, а не про бэкенд. Что модуль рассчитан и на WebGL2-бэкенд, видно из `_init` (строки 158–166):

> ```
> 	_init( { camera, renderer } ) {
>
> 		this.camera = camera;
>
> 		const data = {
> 			webGL: renderer.coordinateSystem === WebGLCoordinateSystem,
> 			reversedDepth: renderer.reversedDepthBuffer
> 		};
> 		this.mainFrustum = new CSMFrustum( data );
> ```

`WebGLCoordinateSystem` — то, что отдаёт `WebGPURenderer` под WebGLBackend; узел строит фрустумы каскадов под обе системы координат. Ссылка: https://raw.githubusercontent.com/mrdoob/three.js/r185/examples/jsm/csm/CSMShadowNode.js

### Что документированно ломается в headless — GTAO

Собственные скриншотные ворота three.js (`test/e2e/puppeteer.js` тега `r185`) исключают часть WebGPU-примеров, и GTAO — в разделе с пометкой «Black screen» (строки 23–32):

> ```
> 	// Black screen
> 	'webgpu_postprocessing_ao',
> 	'webgpu_postprocessing_dof',
> 	'webgpu_postprocessing_ssgi',
> 	'webgpu_postprocessing_ssgi_ballpool',
> 	'webgpu_postprocessing_sss',
> 	'webgpu_postprocessing_traa',
> 	'webgpu_tsl_vfx_linkedparticles',
> 	'webgpu_volume_lighting_traa',
> ```

`webgpu_postprocessing_ao` — это единственный пример GTAO в r185 (проверено по `examples/files.json`: поиск `_ao` даёт ровно `['webgpu_postprocessing_ao']`). Напротив, bloom, FXAA и CSM в списке исключений **отсутствуют**, а примеры существуют: `files.json` даёт `webgpu_postprocessing_bloom`, `webgpu_postprocessing_bloom_emissive`, `webgpu_postprocessing_bloom_selective`, `webgpu_postprocessing_fxaa`, `webgpu_shadowmap_csm` — то есть они проходят скриншотные ворота three.js в программном рендере.

**Важная оговорка про этот источник.** Ворота three.js гоняют WebGPU не через WebGL2-откат, а через программный Vulkan (lavapipe): `puppeteer.js:205–213` и `launchOptions`:

> ```
> 	const flags = [
> 		'--hide-scrollbars',
> 		'--enable-unsafe-webgpu',
> 		'--enable-features=Vulkan',
> 		'--disable-vulkan-surface',
> 		'--ignore-gpu-blocklist',
> 		'--disable-gpu-driver-bug-workarounds',
> 		'--disable-gpu-watchdog',
> 		'--no-sandbox'
> 	];
> ```
> ```
> 		env: { ...process.env, VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json' },
> ```

Значит «Black screen» у GTAO — факт про программный рендер вообще, а не именно про WebGL2-бэкенд; на WebGL2-бэкенде у three.js скриншотных ворот для webgpu-примеров нет вовсе. Ссылка: https://raw.githubusercontent.com/mrdoob/three.js/r185/test/e2e/puppeteer.js (проверено 2026-09-21).

### Попытка измерить вживую — не вышло, это не вывод

Чтобы не гадать, я собрал пробник (`.scratch/probe/probe.html` в worktree): страница поднимает `WebGPURenderer({ forceWebGL: true })` на three `0.185.1` с esm.sh, прогоняет bloom, FXAA, GTAO и `CSMShadowNode` и печатает среднюю яркость кадра. Гонял его в том самом браузере, которым идут ворота — `~/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app` (`--headless=new`, локальный `python3 -m http.server`).

Результата нет: с `--virtual-time-budget=45000` браузер не завершался (в `chrome.err` — бесконечные `registration_request.cc:291 Registration response error message: DEPRECATED_ENDPOINT`, из-за сетевой активности виртуальное время не исчерпывается), без него `--dump-dom` за 45 с не напечатал ничего (`wc -c dom2.html` → 0). Процессы прибиты, порт освобождён. **Поэтому весь Q8 выше — чтение исходников и чужого CI, а не замер.** Что закрыло бы вопрос: `bun install` в репозитории и e2e-спека, которая строит эти четыре узла и сверяет непустоту кадра, один прогон без `E2E_GPU` и один с `E2E_GPU=1`.

### Нужен ли `E2E_GPU=1`

Как этот флаг устроен здесь — `playwright.config.ts:8,12`:

> ```
> // `E2E_GPU=1`: headless Chromium draws on the GPU through ANGLE Metal instead of SwiftShader on the processor, for the
>   ...(process.env.E2E_GPU === '1' ? { launchOptions: { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } } : {}),
> ```

Рекомендация для ворот R3:

- bloom, FXAA, каскадные тени — обычный прогон без `E2E_GPU`; скриншотный пин допустим.
- GTAO — пин скриншота только под `E2E_GPU=1`; в обычном прогоне проверять, что проход строится и кадр не чёрный по порогу, а при чёрном кадре — помечать `skip` с ссылкой на этот файл, а не занижать порог.

## Q9 · electron-builder 26.15.3: Windows `.exe` на macOS arm64

### Что проверено

1. Реестр npm: существование и дата публикации ровно `26.15.3`.
2. Исходники **установленной версии** — tarball `app-builder-lib@26.15.3` (`out/toolsets/windows.js`, `out/toolsets/wine.js`, `out/codeSign/windowsSignToolManager.js`, `out/targets/nsis/NsisTarget.js`, `out/util/macosVersion.js`, `out/util/resEdit.js`, `out/targets/MsiTarget.js`).
3. Документация electron-builder (`website/docs/...` ветки `master`) — с поправкой, что сайт описывает уже v27.
4. Список тегов репозитория electron-builder.

### Вывод в одну строку

**Да: NSIS-инсталлятор и подпись Windows-бинарей файловым сертификатом (`.pfx`/`.p12`) electron-builder 26.15.3 делает на macOS arm64 нативно — Windows-раннер не нужен; Windows-раннер (или VM) обязателен только для сертификата из хранилища Windows, для EV-токена, MSI и appx, а 32-битной Windows-сборки с electron 44.3.0 не будет вообще.** Уверенность: высокая по коду, средняя по подписи (вживую не подписывал).

### Версия существует и она же `latest`

```
$ curl -sS https://registry.npmjs.org/electron-builder | …
latest: {'latest': '26.15.3', 'next': '27.0.0-alpha.8', 'v26': '26.16.1'}
26.15.3 present: True   shasum: 0e82828f6829c0b2596338365209170ac0acbcd5   published: 2026-06-09T17:34:36.991Z
all 26.15.x: ['26.15.0', … '26.15.7']
```

Пин совпадает с dist-tag `latest`, но в линейке v26 уже есть `26.16.1` (dist-tag `v26`), а v27 пока только `27.0.0-alpha.8`. **FYI:** тега `v26.15.3` в git нет (`api.github.com/repos/electron-userland/electron-builder/tags` отдаёт `v29.30.0, v28.0.0, v26.0.20, v26.0.19 …`), поэтому документацию по этой версии из репозитория взять нельзя — всё ниже читается из npm-tarball самой `26.15.3`.

### Подпись: на не-Windows это `osslsigncode`, и для darwin arm64 бинарь есть

`app-builder-lib@26.15.3`, `out/codeSign/windowsSignToolManager.js:184–185`:

> ```
>     computeSignToolArgs(options, isWin, vm = new vm_1.VmManager()) {
>         return isWin ? this.computeWindowsSignArgs(options, vm) : this.computeOsslsigncodeArgs(options, vm);
>     }
> ```

`out/toolsets/windows.js:54–69` выбирает инструмент по платформе:

> ```
> async function getSignToolPath(winCodeSign, isWin) {
> …
>         const vendor = await getOsslSigncodeBundle(winCodeSign);
> ```

`out/toolsets/windows.js:117–133` — какой архив тянется, и для Apple Silicon он свой:

> ```
>     const file = (() => {
>         if (process.platform === "linux") {
> …
>         // darwin arm64
>         if (process.arch === "arm64") {
>             return "win-codesign-darwin-arm64.zip";
>         }
>         return "win-codesign-darwin-x86_64.zip";
>     })();
>     const vendorPath = await _getWindowsToolsBin(winCodeSign, file);
>     return { path: path.resolve(vendorPath, "osslsigncode") };
> ```

Контрольные суммы `win-codesign-darwin-arm64.zip` прописаны в том же файле (строки 32 и 42) — то есть нативный arm64-`osslsigncode` штатно поддержан, без Rosetta.

Документация (ветка `master`, то есть v27, но механика та же) формулирует это прямо — `website/docs/features/code-signing/code-signing-win.md:28`:

> You don't need Windows to sign a Windows app. The default `signtool` method signs file-based certificates with `osslsigncode` on macOS/Linux, and the `pkcs11` and `azure` methods are designed for non-Windows CI.

и строка 95:

> On Windows the signer is Microsoft `signtool.exe`; on macOS/Linux it is `osslsigncode` from the `winCodeSign` toolset bundle — no Wine or Windows VM is involved. Note: certificate-store lookups (`certificateSubjectName` / `certificateSha1`) read the Windows store and therefore require Windows (or the bundled Windows VM), whereas file-based signing works on any platform.

Оговорка про хранилище подтверждается кодом 26.15.3 — `windowsSignToolManager.js:304–309`:

> ```
>     async getCertificateFromStoreInfo(options, vm) {
> …
>         const ps = await vm.powershellCommand.value;
> ```

Ссылка: https://raw.githubusercontent.com/electron-userland/electron-builder/master/website/docs/features/code-signing/code-signing-win.md (проверено 2026-09-21).

### Сборка NSIS на macOS: Wine не нужен

- `makensis` в бандле есть под darwin — `out/toolsets/windows.js`, `getMakeNsisPath`:

  > ```
  >         if (process.platform === "darwin") {
  >             return { path: path.resolve(bundlePath, "mac", "makensis"), env };
  >         }
  > ```

- Правка ресурсов `.exe` (иконка, версия) идёт чистым JS, а не `rcedit` под Wine — `out/util/resEdit.js:6` → `const resedit_1 = require("resedit");`.
- Единственное место NSIS, где мог бы понадобиться Wine, — сборка деинсталлятора запуском стаба. Код `out/targets/nsis/NsisTarget.js:355–374`:

  > ```
  >         if ((0, macosVersion_1.isMacOsCatalina)()) {
  >             try {
  >                 await nsisUtil_1.UninstallerReader.exec(installerPath, uninstallerPath);
  >             }
  >             catch (error) {
  >                 builder_util_1.log.warn(`packager.vm is used: ${error.message}`);
  > …
  >         else {
  >             const wineVm = new WineVm_1.WineVmManager((_a = packager.config.toolsets) === null || _a === void 0 ? void 0 : _a.wine);
  >             await wineVm.exec(installerPath, [], { env: { __COMPAT_LAYER: "RunAsInvoker" } });
  >         }
  > ```

  А `isMacOsCatalina` — это «macOS новее Catalina», по ядру: `out/util/macosVersion.js` →

  > ```
  > function isMacOsCatalina() {
  >     return process.platform === "darwin" && semver.gte((0, os_1.release)(), "19.0.0");
  > }
  > ```

  На этой машине `os.release()` = `27.0.0` (Darwin 27.0.0), то есть ветка `UninstallerReader` — деинсталлятор извлекается из стаба разбором PE на JS, Wine не запускается. Ветка с Wine осталась для macOS старее 10.15.

**Где Wine всё-таки вылезет и почему это больно на arm64.** Бандл Wine под darwin — только x86_64, `out/toolsets/wine.js`:

> ```
> const wineToolsChecksums = {
>     "0.0.0": {
>         "wine-4.0.1-mac.7z": "…",
>     },
>     "1.0.1": {
>         "wine-11.0-darwin-x86_64.tar.xz": "…",
>         "wine-11.0-linux-x86_64.tar.xz": "…",
>     },
> };
> ```

Значит любой путь через Wine на Apple Silicon пойдёт под Rosetta 2. Сейчас таких путей два: цель MSI (`out/targets/MsiTarget.js:28` → `this.vm = process.platform === "win32" ? new vm_1.VmManager() : new WineVm_1.WineVmManager(…)`) и, по документации v27, Azure Trusted Signing (`code-signing-win.md:281` → «On macOS/Linux, `signtool.exe` runs inside Wine using the `winCodeSign` toolset bundle — no separate Windows VM required»).

### Прочие ограничения, которые бьют по E5

- Нативные зависимости. `website/docs/features/multi-platform-build.md`:

  > Don't expect that you can build an app for all platforms on one platform.
  > - If your app has native dependencies, they can only be compiled on the target platform unless [prebuild](https://www.npmjs.com/package/prebuild) is used.
  > - macOS Code Signing works only on macOS. [Cannot be fixed](http://stackoverflow.com/a/12156576).

  Для этого репозитория первое не мешает: `packages/desktop/package.json` ставит `"npmRebuild": false` и `"files": ["out/**", "!node_modules/**"]`, нативных модулей в рендерере нет.
- **32-битной Windows не будет.** Тот же документ:

  > Windows `ia32` and Linux `armv7l` builds require **`electronVersion` &lt;= 43.x** — [Electron 44 removed them](https://github.com/electron/electron/pull/51816). On Electron 44+ electron-builder fails fast with a configuration error (a warning if a custom `electronDist`/mirror is set).

  Репозиторий на `electron 44.3.0`, поэтому целями Windows остаются x64 и arm64.

  Оговорка к цитате: она взята из документации ветки `master`, а это уже electron-builder v27, тогда как в репозитории
  `26.15.3`. Подтверждён только факт со стороны Electron — в 44 32-битной Windows нет. Обещание, что именно
  electron-builder 26.15.3 упадёт с ошибкой конфигурации, **не подтверждено**: grep по `node_modules` нашёл лишь строку
  про Wine-бандл. Вывод от этого не меняется — целями Windows остаются x64 и arm64.
- EV-сертификат на аппаратном токене: встроенного режима в 26.15.3 нет. `website/docs/tutorials/code-signing-windows-apps-on-unix.md`:

  > :::tip[v27: use the built-in PKCS#11 mode]
  > As of v27, electron-builder ships a first-class cross-platform PKCS#11 signing mode — set `win.sign: { type: "pkcs11", pkcs11Module, pkcs11KeyUri, certificateFile }` and it signs via the bundled `osslsigncode` on macOS/Linux with no custom script.

  То есть на 26.15.3 остаётся ручной путь из того же документа: «Signing Windows apps on Unix is supported. You need an application that can sign code using PKCS#11» плюс свой `sign.js` с JSign или `osslsigncode`. Ссылка: https://raw.githubusercontent.com/electron-userland/electron-builder/master/website/docs/tutorials/code-signing-windows-apps-on-unix.md (проверено 2026-09-21).
- Нынешняя конфигурация собирает только macOS: `packages/desktop/package.json` → `"mac": { "target": [{ "target": "dir", "arch": ["arm64"] }], "sign": null }`, а оба скрипта зовут `electron-builder --mac --arm64`. Для Windows нужны `win.target` и `--win`.

### Что осталось непроверенным

- Реальной подписи `.exe` на этой машине не делалось: нет сертификата и нет Windows-цели в конфиге. Настоящая проверка — `electron-builder --win --x64` с тестовым self-signed `.pfx` в `WIN_CSC_LINK`; это закрыло бы вопрос окончательно.
- Azure Trusted Signing на 26.15.3 (файл `out/codeSign/windowsSignAzureManager.js` в пакете есть) не разбирался: по документации v27 путь v26 — PowerShell `Invoke-TrustedSigning`, что на macOS требует pwsh. Помечаю как `unverified`.
