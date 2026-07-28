import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { createDeterministicZip, listFiles } from "./archive.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = JSON.parse(await readFile(path.join(root, "release.config.json"), "utf8"));
const releaseRoot = path.join(root, "release");
const releaseDirectory = path.join(releaseRoot, release.release_tag);
const stagingRoot = path.join(releaseRoot, ".staging");
const modFolderName = `factorio-ai-assistant_${release.version}`;
const companionFolderName = `factorio-ai-assistant-companion-${release.version}`;
const modArchiveName = `${modFolderName}.zip`;
const companionArchiveName =
  `factorio-ai-assistant-companion-windows-x64-${release.version}.zip`;
const bundleName = `factorio-ai-assistant-${release.release_tag}.zip`;
const bundlePath = path.join(releaseRoot, bundleName);
const bundleChecksumPath = `${bundlePath}.sha256`;

await Promise.all([
  rm(releaseDirectory, { recursive: true, force: true }),
  rm(stagingRoot, { recursive: true, force: true }),
  rm(bundlePath, { force: true }),
  rm(bundleChecksumPath, { force: true }),
]);
await mkdir(releaseDirectory, { recursive: true });
await mkdir(stagingRoot, { recursive: true });

const modStaging = path.join(stagingRoot, modFolderName);
await cp(path.join(root, "factorio-mod"), modStaging, { recursive: true });
await createDeterministicZip({
  cwd: stagingRoot,
  output: path.join(releaseDirectory, modArchiveName),
  files: (await listFiles(modStaging)).map((name) => `${modFolderName}/${name}`),
});

const companionStaging = path.join(stagingRoot, companionFolderName);
await mkdir(companionStaging, { recursive: true });
await build({
  entryPoints: [path.join(root, "companion/src/index.ts")],
  outfile: path.join(companionStaging, "companion.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  legalComments: "eof",
  logLevel: "warning",
});
for (const name of [
  "start-companion.cmd",
  "start-companion.ps1",
  "collect-diagnostics.ps1",
  "README.txt",
]) {
  await copyFile(
    path.join(root, "distribution/windows", name),
    path.join(companionStaging, name),
  );
}
await copyFile(
  path.join(root, "companion.config.example.json"),
  path.join(companionStaging, "companion.config.example.json"),
);
await writeFile(
  path.join(companionStaging, "VERSION.json"),
  `${JSON.stringify(
    {
      name: "factorio-ai-assistant-companion",
      version: release.version,
      release_tag: release.release_tag,
      protocol_version: release.protocol_version,
      state_schema_version: release.state_schema_version,
      node_major_version: release.node_major_version,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await createDeterministicZip({
  cwd: stagingRoot,
  output: path.join(releaseDirectory, companionArchiveName),
  files: (await listFiles(companionStaging)).map(
    (name) => `${companionFolderName}/${name}`,
  ),
});

await Promise.all([
  copyFile(
    path.join(root, "companion.config.example.json"),
    path.join(releaseDirectory, "companion.config.example.json"),
  ),
  copyFile(
    path.join(root, "artifacts/performance-baseline.json"),
    path.join(releaseDirectory, "performance-baseline.json"),
  ),
  copyFile(
    path.join(root, `docs/releases/${release.release_tag}.md`),
    path.join(releaseDirectory, "RELEASE_NOTES.md"),
  ),
]);

const manifest = {
  format_version: 1,
  release_tag: release.release_tag,
  version: release.version,
  protocol_version: release.protocol_version,
  state_schema_version: release.state_schema_version,
  factorio_min_version: release.factorio_min_version,
  node_major_version: release.node_major_version,
  assets: [
    { name: modArchiveName, role: "factorio-mod" },
    { name: companionArchiveName, role: "windows-companion" },
    { name: "companion.config.example.json", role: "example-config" },
    { name: "performance-baseline.json", role: "automated-performance-baseline" },
    { name: "RELEASE_NOTES.md", role: "release-notes" },
  ],
};
await writeFile(
  path.join(releaseDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

const checksumNames = [
  modArchiveName,
  companionArchiveName,
  "companion.config.example.json",
  "manifest.json",
  "performance-baseline.json",
  "RELEASE_NOTES.md",
].sort();
const checksumLines = [];
for (const name of checksumNames) {
  checksumLines.push(`${await sha256(path.join(releaseDirectory, name))}  ${name}`);
}
await writeFile(
  path.join(releaseDirectory, "SHA256SUMS"),
  `${checksumLines.join("\n")}\n`,
  "utf8",
);

const releaseFiles = await listFiles(releaseDirectory);
assert.ok(releaseFiles.includes("SHA256SUMS"));
await createDeterministicZip({
  cwd: releaseRoot,
  output: bundlePath,
  files: releaseFiles.map((name) => `${release.release_tag}/${name}`),
});
await writeFile(
  bundleChecksumPath,
  `${await sha256(bundlePath)}  ${bundleName}\n`,
  "utf8",
);
await rm(stagingRoot, { recursive: true, force: true });

console.log(`Release package created at ${releaseDirectory}`);
console.log(`Release bundle created at ${bundlePath}`);

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}
