---
name: simcity-stop-game
description: Stop the SimCity game using the stop_game.sh script and verify the process is gone. Use when ending a session, before restarts, or when the user asks to stop the game. Russian triggers: "останови игру", "выключи SimCity", "заверши игровой процесс", "останови перед перезапуском".
---

# SimCity Stop Game

## Quick Start
1. From the repo root, run `./stop_game.sh` (or `bash ./stop_game.sh`).
2. Verify no processes remain with `pgrep -fl simcity` (should be empty).

## Russian Trigger Equivalents

- останови игру
- выключи SimCity
- заверши игровой процесс
- останови перед перезапуском

## Commands
```bash
./stop_game.sh
pgrep -fl simcity || true
```

## Notes
- The script handles graceful stop + force kill if needed.
- If `pgrep` still shows a process, re-run the script and report the PID(s).
