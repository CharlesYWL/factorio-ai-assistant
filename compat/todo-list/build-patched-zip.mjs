#!/usr/bin/env node
/**
 * Builds a locally patched Todo-List mod ZIP.
 *
 * The script is the reproducible half of `compat/todo-list`: it clones the
 * upstream mod at the commit pinned in `upstream.json`, refuses to continue if
 * the commit does not match, applies the reviewed patch and writes a
 * deterministic archive plus its SHA-256. Re-running it on the same inputs
 * produces a byte identical ZIP.
 *
 * Usage:
 *   node compat/todo-list/build-patched-zip.mjs
 *   node compat/todo-list/build-patched-zip.mjs --out <dir> --expect <sha256>
 *
 * Requires git and network access to github.com.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createDeterministicZip, listFiles, readZipEntries } from "../../scripts/archive.mjs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..", "..");

const options = parseArguments(process.argv.slice(2));
const manifest = JSON.parse(await readFile(path.join(here, "upstream.json"), "utf8"));

const outputDirectory = path.resolve(repositoryRoot, options.out ?? path.join(here, "dist"));
const workDirectory = path.join(outputDirectory, ".work");
const checkoutDirectory = path.join(workDirectory, "upstream");
const stagingDirectory = path.join(workDirectory, "staging");
const modFolderName = manifest.patched.mod_folder;
const archivePath = path.join(outputDirectory, manifest.patched.archive);

await rm(workDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await mkdir(workDirectory, { recursive: true });

await git(workDirectory, [
  "clone",
  "--quiet",
  "--depth",
  "1",
  "--branch",
  manifest.upstream.tag,
  manifest.upstream.repository,
  checkoutDirectory,
]);

const head = (await git(checkoutDirectory, ["rev-parse", "HEAD"])).trim();
assert.equal(
  head,
  manifest.upstream.commit,
  `Upstream ${manifest.upstream.tag} resolved to ${head}, expected ${manifest.upstream.commit}. ` +
    "Refusing to build: the pinned tag was moved or rewritten.",
);

for (const patch of manifest.patches) {
  const patchPath = path.join(here, patch);
  await git(checkoutDirectory, ["apply", "--check", patchPath]);
  await git(checkoutDirectory, ["apply", patchPath]);
}

const patchedInfo = JSON.parse(
  await readFile(path.join(checkoutDirectory, "src", "info.json"), "utf8"),
);
assert.equal(patchedInfo.name, manifest.upstream.name, "The patch must not rename the mod");
assert.equal(
  patchedInfo.version,
  manifest.patched.version,
  "The patched info.json version must match upstream.json",
);

const stagedMod = path.join(stagingDirectory, modFolderName);
await cp(path.join(checkoutDirectory, "src"), stagedMod, { recursive: true });
// Upstream's release pipeline ships the changelog inside the mod folder.
await cp(path.join(checkoutDirectory, "changelog.txt"), path.join(stagedMod, "changelog.txt"));
await cp(path.join(checkoutDirectory, "LICENSE"), path.join(stagedMod, "LICENSE"));

for (const required of ["control.lua", "data.lua", "info.json", "settings.lua"]) {
  await readFile(path.join(stagedMod, required));
}

const files = (await listFiles(stagingDirectory)).filter((name) => !name.endsWith(".DS_Store"));
assert.ok(
  files.includes(`${modFolderName}/todo/features/remote_interface.lua`),
  "The patched archive must contain the remote interface",
);

await rm(archivePath, { force: true });
await createDeterministicZip({ cwd: stagingDirectory, output: archivePath, files });

const entries = await readZipEntries(archivePath);
assert.equal(entries.size, files.length, "Every staged file must end up in the archive");
assert.match(
  entries.get(`${modFolderName}/todo/features/remote_interface.lua`).toString("utf8"),
  new RegExp(`todo\\.remote_interface_name = "${manifest.remote_interface.name}"`, "u"),
  "The archived interface must register the documented remote interface name",
);

const digest = createHash("sha256").update(await readFile(archivePath)).digest("hex");
await writeFile(`${archivePath}.sha256`, `${digest}  ${manifest.patched.archive}\n`, "utf8");

if (options.expect !== undefined) {
  assert.equal(digest, options.expect, "The archive SHA-256 does not match --expect");
}

await rm(workDirectory, { recursive: true, force: true });

process.stdout.write(
  [
    `upstream    ${manifest.upstream.repository} @ ${manifest.upstream.tag} (${manifest.upstream.commit})`,
    `patched     ${manifest.upstream.name} ${manifest.patched.version}`,
    `archive     ${path.relative(repositoryRoot, archivePath)}`,
    `sha256      ${digest}`,
    "",
    "Install by copying the ZIP into the Factorio mods folder and removing the",
    `original ${manifest.upstream.name}_${manifest.upstream.version}.zip first — never load both.`,
    "",
  ].join("\n"),
);

async function git(cwd, args) {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    assert.ok(flag.startsWith("--"), `Unexpected argument: ${flag}`);
    const value = argv[index + 1];
    assert.ok(value !== undefined && !value.startsWith("--"), `Missing value for ${flag}`);
    const name = flag.slice(2);
    assert.ok(["out", "expect"].includes(name), `Unknown option: ${flag}`);
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}
