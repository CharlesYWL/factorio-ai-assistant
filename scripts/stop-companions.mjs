// One-off cleanup: find node processes running the companion and stop them.
import { stopCompanionProcesses } from "./lib/companion-processes.mjs";

const stopped = stopCompanionProcesses(process.pid, (message) =>
  console.log(message),
);

if (stopped === 0) {
  console.log("no companion processes found");
}
