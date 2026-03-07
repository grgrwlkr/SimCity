## Learned User Preferences
- Общаться с пользователем на русском языке.
- Использовать английский язык для commit message и комментариев в коде.
- Давать короткие и прямые ответы без high-level описаний.
- При запросе фикса или объяснения давать конкретный код и точные детали.
- Не дублировать большие блоки кода пользователя без необходимости.

## Learned Workspace Facts
- Проект `SimCity` написан на Rust и Bevy и остаётся single-crate репозиторием.
- Рабочий репозиторий расположен по пути `/Users/xawkay/Developer/SimCity`.
- Проект использует `Rust 1.92.0`, edition `2024`, resolver `3` и `Bevy 0.18.0`.
- Симуляция разделена на `Update` и `FixedUpdate`, а fixed-step работает на `10 Hz`.
- Текущий формат сейвов — `SaveGameV3`.
- Runtime tuning вынесен в `assets/config/*.ron`, сценарии лежат в `assets/scenarios/scenarios.ron`.
- Current-state документация живёт в `README.md` и `docs/`, а historical материалы вынесены в `docs/archive/`.
- Источник истины по текущему состоянию: код в `src/`, runtime config в `assets/`, затем current-state docs в `docs/`.
- В проекте включены remote debugging, HTTP BRP bridge, screenshot handler и debug dump tooling.
- UI поддерживает debug dump window по `F8` и copy dump по `F9`.
- Startup flow сейчас dev-biased: игра автоматически переходит в `InGame` и загружает test city.
- После существенных правок запускать `cargo fmt`, `cargo clippy` и `cargo test`.
- Не выполнять `git commit` и `git push` без явного запроса пользователя.
