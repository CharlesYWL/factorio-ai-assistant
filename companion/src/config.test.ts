import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_COMPANION_PORT,
  loadCompanionConfig,
  resolveCompanionConfig,
} from "./config.js";

void test("uses safe local defaults when no key or provider is configured", () => {
  const config = resolveCompanionConfig({}, {});

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, DEFAULT_COMPANION_PORT);
  assert.equal(config.language, "zh-CN");
  assert.equal(config.samplingIntervalMs, 5_000);
  assert.equal(config.samplingIntervalTicks, 300);
  assert.equal(config.provider, "local");
  assert.equal(config.apiKey, undefined);
  assert.equal(config.modelTimeoutMs, 4_000);
  assert.equal(config.modelRetryCount, 1);
});

void test("environment settings override a validated local config", () => {
  const config = resolveCompanionConfig(
    {
      port: 40_000,
      language: "en",
      sampling_interval_ms: 2_000,
      provider: "ollama",
      model: "file-model",
      provider_url: "http://127.0.0.1:11434",
      model_timeout_ms: 3_000,
      model_retry_count: 0,
      context_budget_bytes: 8_000,
      max_output_tokens: 500,
    },
    {
      FACTORIO_ASSISTANT_COMPANION_PORT: "41000",
      FACTORIO_ASSISTANT_LANGUAGE: "zh-CN",
      FACTORIO_ASSISTANT_MODEL: "environment-model",
    },
  );

  assert.equal(config.port, 41_000);
  assert.equal(config.language, "zh-CN");
  assert.equal(config.model, "environment-model");
  assert.equal(config.provider, "ollama");
  assert.equal(config.modelRetryCount, 0);
});

void test("refuses remote bind addresses and unsafe configuration values", () => {
  assert.throws(
    () => resolveCompanionConfig({ host: "0.0.0.0" }, {}),
    /remote bind address .* is refused/,
  );
  assert.throws(
    () => resolveCompanionConfig({ sampling_interval_ms: 1_500 }, {}),
    /whole number of seconds/,
  );
  assert.throws(
    () => resolveCompanionConfig({ model_retry_count: 2 }, {}),
    /between 0 and 1/,
  );
  assert.throws(
    () => resolveCompanionConfig({ provider_url: "file:///secret" }, {}),
    /must use http or https/,
  );
  assert.throws(
    () => resolveCompanionConfig({ unexpected: true }, {}),
    /Unknown companion config field/,
  );
});

void test("loads credentials only from the selected local file or environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factorio-companion-config-"));
  const path = join(directory, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      provider: "openai-compatible",
      provider_url: "https://example.invalid/v1",
      api_key: "local-secret",
    }),
  );

  try {
    const fromFile = await loadCompanionConfig({ configPath: path, env: {} });
    assert.equal(fromFile.apiKey, "local-secret");

    const fromEnvironment = await loadCompanionConfig({
      configPath: path,
      env: { FACTORIO_ASSISTANT_API_KEY: "environment-secret" },
    });
    assert.equal(fromEnvironment.apiKey, "environment-secret");
  } finally {
    await rm(directory, { recursive: true });
  }
});
