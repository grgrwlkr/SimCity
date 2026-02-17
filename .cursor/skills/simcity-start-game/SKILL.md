---
name: simcity-start-game
description: Start the SimCity game via cargo run, ensure no existing instance, and wait for MCP connectivity. Use when starting the game, before MCP checks, or before live tests that need a running game.
---

# SimCity Start Game

## Quick Start
1. Check for an existing instance (see terminals folder; use `pgrep -fl simcity`).
2. Stop any running instance using `./stop_game.sh` (or `bash ./stop_game.sh`).
3. Run `cargo run` from the repo root with `block_until_ms: 0` to background it.
4. Monitor the terminal output until the game window is created.
5. Wait for MCP: retry `list components` with short sleeps until connected.
6. Keep the game running for at least 60 seconds before stopping or concluding startup checks.

## Commands
```bash
./stop_game.sh
cargo run
```

## MCP Wait Loop
- Try `user-bevy-debugger-observe` with `list components`.
- If not connected, `sleep 1–3s` and retry until it connects or you hit a reasonable timeout.

## Notes
- Always stop any previous instance before starting (R10.6).
- Use the project root as the working directory.
- Report the terminal file path and MCP readiness status.
- Do not stop or restart the game earlier than 1 minute after successful startup, unless the user explicitly requests it.