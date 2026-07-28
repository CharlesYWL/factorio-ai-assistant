import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const [
  release,
  rootPackage,
  lockfile,
  companionPackage,
  protocolPackage,
  calculatorPackage,
  guidePackage,
  modInfo,
  protocolSource,
  serverSource,
  controlSource,
  collectorSource,
  localizationSource,
  releaseNotes,
  guideSource,
  guideDoc,
] = await Promise.all([
  readJson("release.config.json"),
  readJson("package.json"),
  readJson("package-lock.json"),
  readJson("companion/package.json"),
  readJson("packages/protocol/package.json"),
  readJson("packages/calculator/package.json"),
  readJson("packages/guide/package.json"),
  readJson("factorio-mod/info.json"),
  readText("packages/protocol/src/index.ts"),
  readText("companion/src/server.ts"),
  readText("factorio-mod/control.lua"),
  readText("factorio-mod/state_collector.lua"),
  readText("factorio-mod/localization.lua"),
  readText("docs/releases/v0.1.0-rc.1.md"),
  readText("packages/guide/src/data.ts"),
  readText("docs/guide.md"),
]);

assert.match(release.version, /^\d+\.\d+\.\d+$/u, "Release version must be numeric semver");
assert.equal(release.release_tag, `v${release.version}-rc.1`);
for (const [name, manifest] of [
  ["root", rootPackage],
  ["companion", companionPackage],
  ["protocol", protocolPackage],
  ["calculator", calculatorPackage],
  ["guide", guidePackage],
  ["Factorio Mod", modInfo],
]) {
  assert.equal(manifest.version, release.version, `${name} version must match release.config.json`);
}

for (const workspacePath of [
  "",
  "companion",
  "packages/protocol",
  "packages/calculator",
  "packages/guide",
]) {
  assert.equal(
    lockfile.packages[workspacePath].version,
    release.version,
    `package-lock version for ${workspacePath || "root"} must match`,
  );
}

assert.equal(
  readNumericConstant(protocolSource, /PROTOCOL_VERSION = (\d+) as const/u, "protocol"),
  release.protocol_version,
);
assert.equal(
  readNumericConstant(protocolSource, /STATE_SCHEMA_VERSION = (\d+) as const/u, "schema"),
  release.state_schema_version,
);
assert.equal(
  readNumericConstant(controlSource, /local PROTOCOL_VERSION = (\d+)/u, "Mod protocol"),
  release.protocol_version,
);
assert.equal(
  readNumericConstant(controlSource, /local STATE_SCHEMA_VERSION = (\d+)/u, "Mod schema"),
  release.state_schema_version,
);
assert.equal(
  readNumericConstant(
    collectorSource,
    /local STATE_SCHEMA_VERSION = (\d+)/u,
    "collector schema",
  ),
  release.state_schema_version,
);
assert.equal(
  readStringConstant(
    serverSource,
    /COMPANION_VERSION = "([^"]+)"/u,
    "Companion version",
  ),
  release.version,
);
assert.equal(
  readNumericConstant(
    localizationSource,
    /local PROTOCOL_VERSION = (\d+)/u,
    "localization protocol",
  ),
  release.protocol_version,
);
assert.equal(
  readNumericConstant(
    localizationSource,
    /local STATE_SCHEMA_VERSION = (\d+)/u,
    "localization schema",
  ),
  release.state_schema_version,
);
assert.equal(
  readNumericConstant(
    localizationSource,
    /local MAX_ENTRIES_PER_PACKET = (\d+)/u,
    "Mod localization batch size",
  ),
  readNumericConstant(
    protocolSource,
    /MAX_LOCALIZED_NAMES_PER_PACKET = (\d+)/u,
    "protocol localization batch size",
  ),
);
assert.equal(
  readNumericConstant(
    localizationSource,
    /local MAX_NAME_CHARACTERS = (\d+)/u,
    "Mod localized name length",
  ),
  readNumericConstant(
    protocolSource,
    /MAX_LOCALIZED_NAME_CHARACTERS = (\d+)/u,
    "protocol localized name length",
  ),
);
assert.equal(modInfo.name, "factorio-ai-assistant");
assert.equal(modInfo.factorio_version, "2.0");
assert.ok(releaseNotes.includes(release.release_tag), "Release notes must name the RC tag");

const guideVersion = readStringConstant(
  guideSource,
  /GUIDE_VERSION = "([^"]+)"/u,
  "guide version",
);
const guideFactorioVersion = readStringConstant(
  guideSource,
  /GUIDE_FACTORIO_VERSION = "([^"]+)"/u,
  "guide Factorio version",
);
assert.ok(
  guideDoc.includes(guideVersion),
  "docs/guide.md must name the built-in guide version",
);
assert.ok(
  guideDoc.includes(guideFactorioVersion),
  "docs/guide.md must name the Factorio version the guide was verified against",
);
const guideSourceUrls = [...guideSource.matchAll(/url:\s*"([^"]+)"/gu)].map(
  (match) => match[1],
);
assert.ok(guideSourceUrls.length > 0, "The guide must cite at least one source URL");
for (const url of guideSourceUrls) {
  assert.ok(guideDoc.includes(url), `docs/guide.md must cite guide source ${url}`);
}

console.log(
  `Release consistency passed (${release.release_tag}, protocol ${release.protocol_version}, schema ${release.state_schema_version}, guide ${guideVersion} for Factorio ${guideFactorioVersion}).`,
);

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

function readText(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function readNumericConstant(source, pattern, name) {
  const match = pattern.exec(source);
  assert.ok(match?.[1] !== undefined, `Could not find ${name} constant`);
  return Number(match[1]);
}

function readStringConstant(source, pattern, name) {
  const match = pattern.exec(source);
  assert.ok(match?.[1] !== undefined, `Could not find ${name} constant`);
  return match[1];
}
