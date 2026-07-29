#!/usr/bin/env node
// Links the working-tree Factorio mod into the local mods directory so Lua
// changes take effect without repackaging. Pass --unlink to restore the zip.
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DISABLED_SUFFIX = ".disabled";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modSource = path.join(root, "factorio-mod");

const shouldUnlink = process.argv.slice(2).includes("--unlink");
const info = JSON.parse(await readFile(path.join(modSource, "info.json"), "utf8"));
const modDirectoryName = `${info.name}_${info.version}`;
const modsDirectory = resolveModsDirectory();
const linkPath = path.join(modsDirectory, modDirectoryName);
const zipPath = path.join(modsDirectory, `${modDirectoryName}.zip`);
const disabledZipPath = `${zipPath}${DISABLED_SUFFIX}`;

await mkdir(modsDirectory, { recursive: true });

if (shouldUnlink) {
  await unlinkMod();
} else {
  await linkMod();
}

async function linkMod() {
  const existing = await pathKind(linkPath);
  if (existing === "link") {
    await rm(linkPath, { recursive: false, force: true });
  } else if (existing === "directory") {
    throw new Error(
      `${linkPath} is a real directory, not a link. Remove or back it up manually first.`,
    );
  }

  if (existsSync(zipPath)) {
    await rm(disabledZipPath, { force: true });
    await rename(zipPath, disabledZipPath);
    log(`disabled packaged mod → ${path.basename(disabledZipPath)}`);
  }

  await symlink(modSource, linkPath, "junction");
  log(`linked ${linkPath}`);
  log(`      → ${modSource}`);
  log("Edit control.lua/ui.lua, then reload the save in game to apply.");
  log("Changes to data.lua/settings.lua/info.json require a full Factorio restart.");
}

async function unlinkMod() {
  const existing = await pathKind(linkPath);
  if (existing === "link") {
    await rm(linkPath, { recursive: false, force: true });
    log(`removed link ${linkPath}`);
  } else if (existing === "directory") {
    throw new Error(`${linkPath} is a real directory; refusing to delete it.`);
  } else {
    log("no dev link present");
  }

  if (existsSync(disabledZipPath)) {
    await rm(zipPath, { force: true });
    await rename(disabledZipPath, zipPath);
    log(`restored packaged mod → ${path.basename(zipPath)}`);
  }
}

async function pathKind(target) {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) return "link";
    if (stats.isDirectory()) return "directory";
    return "file";
  } catch {
    return "missing";
  }
}

function resolveModsDirectory() {
  const override = process.env.FACTORIO_MODS_DIR?.trim();
  if (override !== undefined && override.length > 0) {
    return path.resolve(override);
  }

  const candidates =
    process.platform === "win32"
      ? [path.join(process.env.APPDATA ?? "", "Factorio", "mods")]
      : process.platform === "darwin"
        ? [
            path.join(
              process.env.HOME ?? "",
              "Library",
              "Application Support",
              "factorio",
              "mods",
            ),
          ]
        : [path.join(process.env.HOME ?? "", ".factorio", "mods")];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `Factorio mods directory not found (tried ${candidates.join(", ")}). Set FACTORIO_MODS_DIR.`,
    );
  }
  return found;
}

function log(message) {
  process.stdout.write(`[dev:mod] ${message}\n`);
}
