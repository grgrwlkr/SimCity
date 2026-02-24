/// <reference types="bun-types-no-globals/lib/index.d.ts" />

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stdin } from "bun";
import {
  computePluginSignature,
  collectTargetFiles,
  findMissingRussianTriggerFiles,
  loadHookState,
  saveHookState,
} from "./russian-trigger-sync-lib";

interface StopHookInput {
  generation_id?: string;
  status: string;
  loop_count: number;
}

const STATE_PATH = resolve(".cursor/hooks/state/russian-trigger-sync.json");
const FOLLOWUP_MESSAGE =
  "Run the `sync-russian-triggers` skill now. Ensure all skills, commands, and agent files contain Russian trigger equivalents, including newly updated plugin cache entries. Update frontmatter `description` with `Russian triggers: ...` where missing, keep existing behavior unchanged, and report which files were changed.";

async function parseHookInput<T>(): Promise<T> {
  const text = await stdin.text();
  return JSON.parse(text) as T;
}

function ensureStateDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function shouldCountTurn(input: StopHookInput): boolean {
  return input.status === "completed" && input.loop_count === 0;
}

async function main(): Promise<number> {
  try {
    const input = await parseHookInput<StopHookInput>();
    const state = loadHookState(STATE_PATH);

    if (input.generation_id && input.generation_id === state.lastProcessedGenerationId) {
      console.log(JSON.stringify({}));
      return 0;
    }
    state.lastProcessedGenerationId = input.generation_id ?? null;

    const files = collectTargetFiles();
    const { signature } = computePluginSignature(files);
    const pluginChanged = state.lastPluginSignature !== null && state.lastPluginSignature !== signature;
    const firstRun = state.lastPluginSignature === null;
    const missingFiles = findMissingRussianTriggerFiles(files);
    state.lastPluginSignature = signature;

    const now = Date.now();
    const cooldownMs = 60_000;
    const inCooldown = now - state.lastPromptAtMs < cooldownMs;

    const shouldPrompt =
      shouldCountTurn(input) &&
      pluginChanged &&
      !inCooldown &&
      !firstRun &&
      missingFiles.length > 0;
    if (shouldPrompt) {
      state.lastPromptAtMs = now;
      ensureStateDir(STATE_PATH);
      saveHookState(STATE_PATH, state);
      console.log(JSON.stringify({ followup_message: FOLLOWUP_MESSAGE }));
      return 0;
    }

    ensureStateDir(STATE_PATH);
    saveHookState(STATE_PATH, state);
    console.log(JSON.stringify({}));
    return 0;
  } catch (error) {
    console.error("[russian-trigger-sync-stop] failed", error);
    console.log(JSON.stringify({}));
    return 0;
  }
}

const exitCode = await main();
process.exit(exitCode);
