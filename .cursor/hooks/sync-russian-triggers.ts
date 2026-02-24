/// <reference types="bun-types-no-globals/lib/index.d.ts" />

import { syncRussianTriggers } from "./russian-trigger-sync-lib";

function parseArgs(args: string[]): { checkOnly: boolean; verbose: boolean } {
  return {
    checkOnly: args.includes("--check"),
    verbose: args.includes("--verbose"),
  };
}

async function main(args: string[]): Promise<number> {
  const { checkOnly, verbose } = parseArgs(args);
  try {
    const result = syncRussianTriggers(!checkOnly);
    const payload = {
      mode: checkOnly ? "check" : "write",
      scanned: result.scanned,
      updated: result.updated.length,
      unchanged: result.unchanged.length,
      missing_after_sync: result.missingAfterSync.length,
      plugin_files_count: result.pluginFilesCount,
      plugin_signature: result.pluginSignature,
      ...(verbose
        ? {
            updated_files: result.updated,
            missing_files: result.missingAfterSync,
          }
        : {}),
    };

    console.log(JSON.stringify(payload, null, 2));
    if (checkOnly && result.missingAfterSync.length > 0) {
      return 1;
    }
    return 0;
  } catch (error) {
    console.error("[sync-russian-triggers] failed", error);
    return 2;
  }
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
