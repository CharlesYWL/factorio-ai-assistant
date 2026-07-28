Factorio AI Assistant Companion 0.1.0
=====================================

Requirements:
- Windows 10/11
- Node.js 22 or newer
- Factorio 2.0.59 or newer

Start:
1. Optional: copy companion.config.example.json to companion.config.json.
2. Run start-companion.cmd.
3. Keep the window open while Factorio is running.

Diagnostics:
Run collect-diagnostics.ps1, then review the generated ZIP before sharing it.
The collector copies only the Companion log, Factorio current log, basic
versions, and a redacted configuration. It does not collect saves or API keys.

Important: enabling any Factorio Mod disables Steam achievements for that save.
