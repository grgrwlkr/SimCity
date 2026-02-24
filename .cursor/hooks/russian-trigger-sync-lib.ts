import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, resolve } from "node:path";

type TargetKind = "skill" | "command" | "agent";
type TargetSource = "project" | "plugin" | "personal" | "codex";

export interface TargetFile {
  path: string;
  kind: TargetKind;
  source: TargetSource;
  name: string;
}

export interface SyncResult {
  scanned: number;
  updated: string[];
  unchanged: string[];
  missingAfterSync: string[];
  pluginSignature: string;
  pluginFilesCount: number;
}

const HOME_DIR = process.env.HOME ?? "";
const WORKSPACE_ROOT = process.cwd();

const RUSSIAN_MARKERS = [
  /Russian triggers:/i,
  /Русские триггеры/i,
  /Russian Trigger Equivalents/i,
  /Русские эквиваленты триггеров/i,
];

const TRIGGERS_BY_NAME: Record<string, string[]> = {
  "make-no-mistakes": ["без ошибок", "максимальная точность", "проверь дважды", "не ошибись"],
  "simcity-start-game": ["запусти игру", "стартани SimCity", "подними игру перед MCP", "перезапусти игру"],
  "simcity-stop-game": ["останови игру", "выключи SimCity", "заверши игровой процесс", "останови перед перезапуском"],
  "sync-russian-triggers": [
    "синхронизируй русские триггеры",
    "пропиши русские триггеры",
    "обнови русские триггеры после апдейта",
  ],
  "skill-creator": ["создай новый скилл", "помоги написать SKILL.md", "обнови существующий скилл"],
  "skill-installer": ["установи скилл", "покажи доступные скиллы", "установи скилл из GitHub"],
  "subagent-driven-development": [
    "разработка через сабагентов",
    "выполни задачи сабагентами",
    "делегируй независимые задачи",
  ],
  "verification-before-completion": [
    "проверь перед завершением",
    "подтверди что фикс работает",
    "не закрывай без верификации",
  ],
  "writing-skills": ["создай скилл", "обнови скилл", "проверь качество скилла"],
  "receiving-code-review": ["обработай фидбек ревью", "разбери замечания", "проверь правки из ревью"],
  "requesting-code-review": ["запроси код-ревью", "попроси ревью", "проверь перед merge"],
  "writing-plans": ["напиши план", "разбей на задачи", "план реализации"],
  brainstorming: ["брейншторм", "продумай дизайн", "сначала обсуди идею"],
  "finishing-a-development-branch": [
    "заверши ветку",
    "подготовь ветку к интеграции",
    "что делать с готовой веткой",
  ],
  "executing-plans": ["выполни план", "реализуй по плану", "работай по шагам плана"],
  "dispatching-parallel-agents": [
    "запусти агентов параллельно",
    "распараллель задачи",
    "несколько агентов одновременно",
  ],
  "using-superpowers": ["используй суперсилы", "подключи навыки", "проверь релевантные скиллы"],
  "systematic-debugging": ["систематически дебажь", "найди корень проблемы", "разбери падение по шагам"],
  "test-driven-development": ["сделай через TDD", "сначала тест", "красный-зеленый-рефакторинг"],
  "using-git-worktrees": ["создай worktree", "изолируй работу в worktree", "новый ворктри для фичи"],
  "create-plugin-scaffold": ["создай каркас плагина", "инициализируй плагин Cursor", "скелет плагина"],
  "review-plugin-submission": [
    "проверь плагин перед публикацией",
    "аудит plugin submission",
    "валидация манифеста плагина",
  ],
  "check-compiler-errors": ["проверь ошибки компиляции", "прогони type-check", "покажи compiler errors"],
  "fix-ci": ["почини CI", "исправь упавший pipeline", "разбери логи CI"],
  deslop: ["почисти slop", "убери ИИ-слизь", "почисти стиль кода"],
  "run-smoke-tests": ["прогони smoke-тесты", "запусти смоук", "быстрая e2e проверка"],
  "review-and-ship": ["сделай ревью и отправь", "доведи до ship", "подготовь PR к отправке"],
  "fix-merge-conflicts": ["разрули merge conflicts", "почини конфликты слияния", "разреши конфликт"],
  "loop-on-ci": ["мониторь CI до зеленого", "цикл фиксов CI", "чини пока CI не пройдет"],
  "what-did-i-get-done": ["что я сделал", "дай сводку коммитов", "итоги за период"],
  "weekly-review": ["еженедельный обзор", "weekly review коммитов", "сводка недели"],
  "new-branch-and-pr": ["создай ветку и PR", "новая ветка + пулл-реквест", "открой PR"],
  "get-pr-comments": ["получи комментарии PR", "вытащи review comments", "покажи замечания в PR"],
  "continual-learning": [
    "обнови AGENTS.md из прошлых чатов",
    "извлеки предпочтения из транскриптов",
    "инкрементальное обучение агента",
  ],
  "dev-planner": ["составь план", "разбей на задачи", "оценка сроков", "дорожная карта"],
  "test-engineer": ["напиши тесты", "покрой тестами", "проверь краевые случаи", "негативные кейсы"],
  "story-generator": ["сгенерируй user story", "критерии приемки", "given when then", "разбей в истории"],
  "project-manager": ["менеджер проекта", "оркестрируй задачу", "делегируй агентам", "доведи до готовности"],
  "rust-bevy-architect": ["реализуй на Rust/Bevy", "сделай систему Bevy", "внедри фичу в Bevy"],
  "bug-analyzer": ["падает", "сломалось", "регресс", "флаки", "гонка", "почему не работает"],
  "code-reviewer": ["сделай ревью", "проверь код", "проверь безопасность", "проверь производительность"],
  "ui-sketcher": ["сделай макет", "набросай интерфейс", "вайрфрейм", "UX flow", "ASCII интерфейс"],
  "ci-watcher": ["проверь CI", "посмотри статусы проверок", "почему упал pipeline", "дождись зеленого CI"],
  "plugin-architect": ["спроектируй плагин Cursor", "архитектура плагина", "подбери компоненты плагина"],
  commit: ["сделай коммит", "закоммить изменения", "создай коммит", "коммитни это"],
  "write-plan": ["напиши план", "разбей на шаги", "план реализации"],
  "execute-plan": ["выполни план", "реализуй по шагам", "работай по плану"],
};

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function walkFiles(root: string, onFile: (absPath: string) => void): void {
  if (!existsSync(root)) {
    return;
  }
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git") {
        continue;
      }
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        onFile(fullPath);
      }
    }
  }
}

function normalizeName(raw: string): string {
  return raw.trim().toLowerCase();
}

function humanizeSlug(slug: string): string {
  return slug.replace(/[-_]+/g, " ").trim();
}

function fallbackTriggers(name: string): string[] {
  const readable = humanizeSlug(name);
  return [`используй ${readable}`, `запусти ${readable}`, `примени ${readable}`];
}

function getTriggersFor(name: string): string[] {
  const normalized = normalizeName(name);
  return TRIGGERS_BY_NAME[normalized] ?? fallbackTriggers(normalized || "навык");
}

function isSkillFile(path: string): boolean {
  return path.endsWith("/SKILL.md");
}

function isCommandFile(path: string): boolean {
  return path.includes("/commands/") && [".md", ".txt"].includes(extname(path));
}

function isAgentFile(path: string): boolean {
  return path.includes("/agents/") && extname(path) === ".md";
}

function detectKind(path: string): TargetKind | null {
  if (isSkillFile(path)) {
    return "skill";
  }
  if (isCommandFile(path)) {
    return "command";
  }
  if (isAgentFile(path)) {
    return "agent";
  }
  return null;
}

function parseFrontmatter(content: string): { frontmatter: string; start: number; end: number } | null {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return null;
  }
  const delimiter = content.includes("\r\n") ? "\r\n" : "\n";
  const marker = `${delimiter}---${delimiter}`;
  const endIdx = content.indexOf(marker, 3);
  if (endIdx < 0) {
    return null;
  }
  const frontmatterStart = 3 + delimiter.length;
  const frontmatterEnd = endIdx;
  return {
    frontmatter: content.slice(frontmatterStart, frontmatterEnd),
    start: frontmatterStart,
    end: frontmatterEnd,
  };
}

function parseNameFromFrontmatter(frontmatter: string): string | null {
  const match = frontmatter.match(/^\s*name:\s*(.+)\s*$/m);
  if (!match) {
    return null;
  }
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function resolveTargetName(path: string, content: string): string {
  const fm = parseFrontmatter(content);
  if (fm) {
    const parsedName = parseNameFromFrontmatter(fm.frontmatter);
    if (parsedName) {
      return normalizeName(parsedName);
    }
  }
  return normalizeName(basename(path, extname(path)));
}

function hasRussianMarkers(content: string): boolean {
  return RUSSIAN_MARKERS.some((marker) => marker.test(content));
}

function patchDescription(frontmatter: string, triggers: string[]): string {
  const triggerText = triggers.join('", "');
  const lines = frontmatter.split(/\r?\n/);
  const idx = lines.findIndex((line) => /^\s*description:\s*/.test(line));
  if (idx < 0) {
    return frontmatter;
  }

  const current = lines[idx];
  if (/^\s*description:\s*[>|]/.test(current)) {
    const indent = (current.match(/^(\s*)/)?.[1] ?? "") + "  ";
    lines.splice(idx + 1, 0, `${indent}Russian triggers: "${triggerText}".`);
    return lines.join("\n");
  }

  const match = current.match(/^(\s*description:\s*)(.*)$/);
  if (!match) {
    return frontmatter;
  }

  const prefix = match[1];
  const rawValue = match[2].trim();
  const base = rawValue.length === 0 ? "Auto-generated description." : rawValue;

  let normalizedBase: string;
  if (
    (base.startsWith('"') && base.endsWith('"')) ||
    (base.startsWith("'") && base.endsWith("'"))
  ) {
    normalizedBase = base.slice(1, -1);
  } else {
    normalizedBase = base;
  }

  const separator = /[.!?]$/.test(normalizedBase) ? " " : ". ";
  const withTriggers = `${normalizedBase}${separator}Russian triggers: "${triggerText}".`;
  const escaped = withTriggers.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  lines[idx] = `${prefix}"${escaped}"`;
  return lines.join("\n");
}

function withUpdatedFrontmatter(content: string, updatedFrontmatter: string): string {
  const fm = parseFrontmatter(content);
  if (!fm) {
    return content;
  }
  return `${content.slice(0, fm.start)}${updatedFrontmatter}${content.slice(fm.end)}`;
}

function ensureLocalTriggerSection(path: string, content: string, triggers: string[]): string {
  const isLocalSkill = path.startsWith(resolve(WORKSPACE_ROOT, ".cursor/skills/"));
  const isLocalCommand = path.startsWith(resolve(WORKSPACE_ROOT, ".cursor/commands/"));
  if (!isLocalSkill && !isLocalCommand) {
    return content;
  }
  if (/## Russian Trigger Equivalents/i.test(content)) {
    return content;
  }
  const bullets = triggers.map((trigger) => `- ${trigger}`).join("\n");
  const suffix = `\n\n## Russian Trigger Equivalents\n\n${bullets}\n`;
  return `${content.trimEnd()}${suffix}`;
}

function collectPluginNames(): string[] {
  const settingsPath = resolve(WORKSPACE_ROOT, ".cursor/settings.json");
  const settings = readJsonFile<{ plugins?: Record<string, { enabled?: boolean } | boolean> }>(
    settingsPath,
    {}
  );
  const plugins = settings.plugins ?? {};
  return Object.entries(plugins)
    .filter(([, value]) => {
      if (typeof value === "boolean") {
        return value;
      }
      return value?.enabled !== false;
    })
    .map(([name]) => name);
}

function collectPluginRoots(pluginNames: string[]): string[] {
  if (HOME_DIR.length === 0) {
    return [];
  }
  const cacheRoot = resolve(HOME_DIR, ".cursor/plugins/cache");
  if (!existsSync(cacheRoot)) {
    return [];
  }
  const providerDirs = readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(cacheRoot, entry.name));

  const roots: string[] = [];
  for (const providerDir of providerDirs) {
    for (const pluginName of pluginNames) {
      const pluginRoot = resolve(providerDir, pluginName);
      if (!existsSync(pluginRoot)) {
        continue;
      }
      roots.push(pluginRoot);
    }
  }
  return roots;
}

function pushTarget(
  files: Map<string, TargetFile>,
  absPath: string,
  source: TargetSource,
  kind: TargetKind
): void {
  if (files.has(absPath)) {
    return;
  }
  let content = "";
  try {
    content = readFileSync(absPath, "utf-8");
  } catch {
    return;
  }
  files.set(absPath, {
    path: absPath,
    kind,
    source,
    name: resolveTargetName(absPath, content),
  });
}

export function collectTargetFiles(): TargetFile[] {
  const targets = new Map<string, TargetFile>();

  const addDirectory = (root: string, source: TargetSource) => {
    walkFiles(root, (filePath) => {
      const kind = detectKind(filePath);
      if (!kind) {
        return;
      }
      pushTarget(targets, filePath, source, kind);
    });
  };

  addDirectory(resolve(WORKSPACE_ROOT, ".cursor"), "project");
  addDirectory(resolve(HOME_DIR, ".cursor/skills"), "personal");
  addDirectory(resolve(HOME_DIR, ".codex/skills"), "codex");

  const pluginNames = collectPluginNames();
  for (const pluginRoot of collectPluginRoots(pluginNames)) {
    addDirectory(pluginRoot, "plugin");
  }

  return [...targets.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function findMissingRussianTriggerFiles(files: TargetFile[]): string[] {
  const missing: string[] = [];
  for (const file of files) {
    let content = "";
    try {
      content = readFileSync(file.path, "utf-8");
    } catch {
      continue;
    }
    if (!hasRussianMarkers(content)) {
      missing.push(file.path);
    }
  }
  return missing;
}

export function computePluginSignature(files: TargetFile[]): { signature: string; count: number } {
  const pluginFiles = files.filter((file) => file.source === "plugin");
  const hash = createHash("sha256");
  for (const file of pluginFiles) {
    try {
      const stat = statSync(file.path);
      hash.update(`${file.path}|${stat.size}|${stat.mtimeMs.toFixed(0)}\n`);
    } catch {
      hash.update(`${file.path}|missing\n`);
    }
  }
  return { signature: hash.digest("hex"), count: pluginFiles.length };
}

export function syncRussianTriggers(write: boolean): SyncResult {
  const files = collectTargetFiles();
  const updated: string[] = [];
  const unchanged: string[] = [];

  for (const file of files) {
    let content = "";
    try {
      content = readFileSync(file.path, "utf-8");
    } catch {
      unchanged.push(file.path);
      continue;
    }

    if (hasRussianMarkers(content)) {
      unchanged.push(file.path);
      continue;
    }

    const triggers = getTriggersFor(file.name);
    const fm = parseFrontmatter(content);
    if (!fm) {
      unchanged.push(file.path);
      continue;
    }

    const patchedFrontmatter = patchDescription(fm.frontmatter, triggers);
    let patched = withUpdatedFrontmatter(content, patchedFrontmatter);
    patched = ensureLocalTriggerSection(file.path, patched, triggers);

    if (patched === content) {
      unchanged.push(file.path);
      continue;
    }

    if (write) {
      writeFileSync(file.path, patched, "utf-8");
    }
    updated.push(file.path);
  }

  const filesAfter = collectTargetFiles();
  const missingAfterSync = findMissingRussianTriggerFiles(filesAfter);
  const { signature, count } = computePluginSignature(filesAfter);
  return {
    scanned: files.length,
    updated,
    unchanged,
    missingAfterSync,
    pluginSignature: signature,
    pluginFilesCount: count,
  };
}

export interface HookState {
  version: 1;
  lastProcessedGenerationId: string | null;
  lastPluginSignature: string | null;
  lastPromptAtMs: number;
}

export function loadHookState(statePath: string): HookState {
  const fallback: HookState = {
    version: 1,
    lastProcessedGenerationId: null,
    lastPluginSignature: null,
    lastPromptAtMs: 0,
  };
  if (!existsSync(statePath)) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<HookState>;
    if (parsed.version !== 1) {
      return fallback;
    }
    return {
      version: 1,
      lastProcessedGenerationId:
        typeof parsed.lastProcessedGenerationId === "string" ? parsed.lastProcessedGenerationId : null,
      lastPluginSignature:
        typeof parsed.lastPluginSignature === "string" ? parsed.lastPluginSignature : null,
      lastPromptAtMs:
        typeof parsed.lastPromptAtMs === "number" && Number.isFinite(parsed.lastPromptAtMs)
          ? parsed.lastPromptAtMs
          : 0,
    };
  } catch {
    return fallback;
  }
}

export function saveHookState(statePath: string, state: HookState): void {
  const dir = resolve(statePath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}
