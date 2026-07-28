import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createLocalizationUpdatePacket,
  decodePacket,
  type LocalizationUpdatePacket,
} from "@factorio-ai-assistant/protocol";

import {
  IDENTIFIER_NAMES,
  LocalizedNameStore,
  localizedNameMap,
} from "./localization.js";

const fixtureDirectory = new URL(
  "../../packages/protocol/fixtures/",
  import.meta.url,
);

void test("resolves Chinese display names and falls back to identifiers", async () => {
  const store = new LocalizedNameStore();

  assert.equal(store.locale, undefined);
  assert.equal(store.display("item", "iron-plate"), "iron-plate");

  store.apply(await readLocalization("vanilla-2.0-localization-zh-CN.json"));

  assert.equal(store.locale, "zh-CN");
  assert.equal(store.display("item", "iron-plate"), "铁板");
  assert.equal(store.display("item", "copper-plate"), "铜板");
  assert.equal(store.display("item", "steel-plate"), "钢材");
  assert.equal(store.display("item", "electronic-circuit"), "电子电路");
  assert.equal(store.display("item", "advanced-circuit"), "高级电路");
  assert.equal(store.display("item", "processing-unit"), "处理器");
  assert.equal(store.display("fluid", "petroleum-gas"), "石油气");
  assert.equal(store.display("fluid", "light-oil"), "轻油");
  assert.equal(store.display("fluid", "heavy-oil"), "重油");
  assert.equal(store.display("machine", "assembling-machine-2"), "组装机 2 型");
  for (const pack of [
    "automation",
    "logistic",
    "military",
    "chemical",
    "production",
    "utility",
    "space",
  ]) {
    assert.match(store.display("item", `${pack}-science-pack`), /科技包$/u);
  }

  // Unknown identifiers and untranslated kinds stay on the stable key.
  assert.equal(store.display("item", "uranium-ore"), "uranium-ore");
  assert.equal(store.display("recipe", "iron-plate"), "iron-plate");
  assert.equal(store.lookup("item", "uranium-ore"), undefined);
  assert.equal(store.describe("item", "iron-plate"), "铁板 (iron-plate)");
  assert.equal(store.describe("item", "uranium-ore"), "uranium-ore");
});

void test("switching locale replaces the cache instead of merging it", async () => {
  const store = new LocalizedNameStore();
  store.apply(await readLocalization("vanilla-2.0-localization-zh-CN.json"));
  const chineseSize = store.size;
  assert.ok(chineseSize > 0);

  store.apply(await readLocalization("vanilla-2.0-localization-en.json"));

  assert.equal(store.locale, "en");
  assert.equal(store.size, chineseSize);
  assert.equal(store.display("item", "iron-plate"), "Iron plate");
  assert.equal(store.display("fluid", "heavy-oil"), "Heavy oil");
});

void test("incremental updates merge, and reset clears stale names", () => {
  const store = new LocalizedNameStore();
  store.apply(
    createLocalizationUpdatePacket({
      messageId: "factorio-locale-1",
      tick: 60,
      locale: "zh-CN",
      reset: true,
      names: [{ kind: "item", id: "iron-plate", name: "铁板" }],
    }),
  );
  store.apply(
    createLocalizationUpdatePacket({
      messageId: "factorio-locale-2",
      tick: 120,
      locale: "zh-CN",
      reset: false,
      names: [{ kind: "item", id: "copper-plate", name: "铜板" }],
    }),
  );

  assert.equal(store.size, 2);
  assert.equal(store.display("item", "iron-plate"), "铁板");

  store.apply(
    createLocalizationUpdatePacket({
      messageId: "factorio-locale-3",
      tick: 180,
      locale: "zh-CN",
      reset: true,
      names: [{ kind: "item", id: "copper-plate", name: "铜板" }],
    }),
  );

  assert.equal(store.size, 1);
  assert.equal(store.display("item", "iron-plate"), "iron-plate");
});

void test("identifier lookup keeps every id unchanged", () => {
  assert.equal(IDENTIFIER_NAMES.locale, undefined);
  assert.equal(IDENTIFIER_NAMES.display("item", "iron-plate"), "iron-plate");
  assert.equal(
    IDENTIFIER_NAMES.display("item", "iron-plate", "铁板"),
    "铁板",
  );
  assert.equal(IDENTIFIER_NAMES.lookup("item", "iron-plate"), undefined);
  assert.equal(IDENTIFIER_NAMES.describe("item", "iron-plate"), "iron-plate");
  assert.deepEqual(
    localizedNameMap(IDENTIFIER_NAMES, [["item", "iron-plate"]]),
    {},
  );
});

void test("builds a compact name map for referenced identifiers only", async () => {
  const store = new LocalizedNameStore();
  store.apply(await readLocalization("vanilla-2.0-localization-zh-CN.json"));

  assert.deepEqual(
    localizedNameMap(store, [
      ["item", "iron-plate"],
      ["fluid", "petroleum-gas"],
      ["item", "uranium-ore"],
    ]),
    {
      "item:iron-plate": "铁板",
      "fluid:petroleum-gas": "石油气",
    },
  );
});

async function readLocalization(
  fileName: string,
): Promise<LocalizationUpdatePacket> {
  const packet = decodePacket(
    await readFile(new URL(fileName, fixtureDirectory), "utf8"),
  );
  assert.equal(packet.type, "localization_update");
  return packet;
}
