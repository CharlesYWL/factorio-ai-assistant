// One-off cleanup: find node processes running the companion and stop them.
// Matching on the command line keeps unrelated node tooling untouched.
import { execSync } from "node:child_process";

const output = execSync(
  "powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter \\\"Name='node.exe'\\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress\"",
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);

const rows = JSON.parse(output);
const list = Array.isArray(rows) ? rows : [rows];
const targets = list.filter(
  (row) =>
    typeof row.CommandLine === "string" &&
    /companion[\\/]dist[\\/]index\.js/i.test(row.CommandLine),
);

if (targets.length === 0) {
  console.log("no companion processes found");
} else {
  for (const target of targets) {
    console.log("stopping", target.ProcessId);
    try {
      process.kill(target.ProcessId, "SIGKILL");
    } catch (error) {
      console.log("  could not stop:", error.code ?? error.message);
    }
  }
}
