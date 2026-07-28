import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readZipEntries } from "./archive.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = JSON.parse(await readFile(path.join(root, "release.config.json"), "utf8"));
const releaseRoot = path.join(root, "release");
const releaseDirectory = path.join(releaseRoot, release.release_tag);
const modArchiveName = `factorio-ai-assistant_${release.version}.zip`;
const companionArchiveName =
  `factorio-ai-assistant-companion-windows-x64-${release.version}.zip`;
const bundleName = `factorio-ai-assistant-${release.release_tag}.zip`;

const checksums = parseChecksums(
  await readFile(path.join(releaseDirectory, "SHA256SUMS"), "utf8"),
);
const expectedChecksums = [
  modArchiveName,
  companionArchiveName,
  "companion.config.example.json",
  "manifest.json",
  "performance-baseline.json",
  "RELEASE_NOTES.md",
].sort();
assert.deepEqual([...checksums.keys()].sort(), expectedChecksums);
for (const [name, expected] of checksums) {
  assert.equal(await sha256(path.join(releaseDirectory, name)), expected, `${name} checksum`);
}

const manifest = JSON.parse(
  await readFile(path.join(releaseDirectory, "manifest.json"), "utf8"),
);
assert.equal(manifest.release_tag, release.release_tag);
assert.equal(manifest.version, release.version);
assert.equal(manifest.protocol_version, release.protocol_version);
assert.equal(manifest.state_schema_version, release.state_schema_version);

const modEntries = await readZipEntries(path.join(releaseDirectory, modArchiveName));
const modPrefix = `factorio-ai-assistant_${release.version}/`;
assert.ok(modEntries.has(`${modPrefix}info.json`));
assert.ok(modEntries.has(`${modPrefix}control.lua`));
assert.ok(modEntries.has(`${modPrefix}locale/en/locale.cfg`));
assert.ok(modEntries.has(`${modPrefix}locale/zh-CN/locale.cfg`));
const modInfo = JSON.parse(modEntries.get(`${modPrefix}info.json`).toString("utf8"));
assert.equal(modInfo.name, "factorio-ai-assistant");
assert.equal(modInfo.version, release.version);
assert.ok([...modEntries.keys()].every((name) => name.startsWith(modPrefix)));

const companionEntries = await readZipEntries(
  path.join(releaseDirectory, companionArchiveName),
);
const companionPrefix = `factorio-ai-assistant-companion-${release.version}/`;
for (const name of [
  "companion.mjs",
  "start-companion.cmd",
  "start-companion.ps1",
  "collect-diagnostics.ps1",
  "companion.config.example.json",
  "README.txt",
  "VERSION.json",
]) {
  assert.ok(companionEntries.has(`${companionPrefix}${name}`), `Missing ${name}`);
}
const version = JSON.parse(
  companionEntries.get(`${companionPrefix}VERSION.json`).toString("utf8"),
);
assert.equal(version.version, release.version);
assert.equal(version.release_tag, release.release_tag);
assert.equal(version.protocol_version, release.protocol_version);

const temporaryDirectory = await mkdtemp(
  path.join(tmpdir(), "factorio-assistant-release-"),
);
try {
  const bundledCompanion = path.join(temporaryDirectory, "companion.mjs");
  await writeFile(
    bundledCompanion,
    companionEntries.get(`${companionPrefix}companion.mjs`),
  );
  const versionResult = spawnSync(process.execPath, [bundledCompanion, "--version"], {
    encoding: "utf8",
  });
  assert.equal(versionResult.status, 0, versionResult.stderr);
  assert.equal(versionResult.stdout.trim(), release.version);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

const bundlePath = path.join(releaseRoot, bundleName);
const bundleEntries = await readZipEntries(bundlePath);
const bundledNames = new Set(
  expectedChecksums
    .concat("SHA256SUMS")
    .map((name) => `${release.release_tag}/${name}`),
);
assert.deepEqual(new Set(bundleEntries.keys()), bundledNames);
const bundleChecksum = parseChecksums(
  await readFile(`${bundlePath}.sha256`, "utf8"),
);
assert.equal(bundleChecksum.size, 1);
assert.equal(bundleChecksum.get(bundleName), await sha256(bundlePath));

console.log(
  `Release package verified (${modEntries.size} Mod files, ${companionEntries.size} Companion files).`,
);

function parseChecksums(source) {
  const values = new Map();
  for (const line of source.trim().split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
    assert.ok(match?.[1] !== undefined && match[2] !== undefined, `Invalid checksum: ${line}`);
    assert.ok(!values.has(match[2]), `Duplicate checksum entry: ${match[2]}`);
    values.set(match[2], match[1]);
  }
  return values;
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}
