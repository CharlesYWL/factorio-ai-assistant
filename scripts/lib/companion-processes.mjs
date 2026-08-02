// Locate and stop stray companion processes by matching their command line, so
// unrelated node tooling is left untouched.
import { execSync } from "node:child_process";

const ENTRY_PATTERN = /companion[\\/]dist[\\/]index\.js/i;

export const findCompanionProcesses = (excludePid) => {
  const output = execSync(
    "powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter \\\"Name='node.exe'\\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress\"",
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );

  const rows = JSON.parse(output);
  const list = Array.isArray(rows) ? rows : [rows];

  return list
    .filter(
      (row) =>
        typeof row.CommandLine === "string" &&
        ENTRY_PATTERN.test(row.CommandLine) &&
        row.ProcessId !== excludePid,
    )
    .map((row) => row.ProcessId);
};

export const stopCompanionProcesses = (excludePid, onMessage = () => {}) => {
  let processIds;
  try {
    processIds = findCompanionProcesses(excludePid);
  } catch (error) {
    onMessage(`could not enumerate processes: ${error.message}`);
    return 0;
  }

  for (const processId of processIds) {
    onMessage(`stopping stray companion ${processId}`);
    try {
      process.kill(processId, "SIGKILL");
    } catch (error) {
      onMessage(`  could not stop: ${error.code ?? error.message}`);
    }
  }
  return processIds.length;
};
