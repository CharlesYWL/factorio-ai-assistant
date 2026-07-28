import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDeterministicZip,
  listFiles,
  readZipEntries,
} from "./archive.mjs";

void test("creates deterministic, round-trippable ZIP archives", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "factorio-assistant-archive-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "input");
  await mkdir(path.join(input, "nested"), { recursive: true });
  await writeFile(path.join(input, "alpha.txt"), "alpha\n", "utf8");
  await writeFile(path.join(input, "nested", "beta.txt"), "beta\n", "utf8");

  const files = await listFiles(input);
  const first = path.join(directory, "first.zip");
  const second = path.join(directory, "second.zip");
  await createDeterministicZip({ cwd: input, output: first, files });
  await createDeterministicZip({ cwd: input, output: second, files: files.toReversed() });

  assert.deepEqual(await readFile(second), await readFile(first));
  const entries = await readZipEntries(first);
  assert.deepEqual([...entries.keys()], ["alpha.txt", "nested/beta.txt"]);
  assert.equal(entries.get("alpha.txt")?.toString("utf8"), "alpha\n");
  assert.equal(entries.get("nested/beta.txt")?.toString("utf8"), "beta\n");
});
