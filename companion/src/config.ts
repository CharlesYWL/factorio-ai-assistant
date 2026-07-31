import { readFile, stat } from "node:fs/promises";

export const LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_COMPANION_PORT = 34_197;
export const DEFAULT_SAMPLING_INTERVAL_MS = 5_000;
export const DEFAULT_MODEL_TIMEOUT_MS = 12_000;
export const DEFAULT_CONTEXT_BUDGET_BYTES = 60_000;
export const MAX_CONFIG_BYTES = 64 * 1024;

const MIN_SAMPLING_INTERVAL_MS = 1_000;
const MAX_SAMPLING_INTERVAL_MS = 60_000;
const MIN_MODEL_TIMEOUT_MS = 250;
// Kept below the executor's total budget so a per-attempt timeout can never
// consume it entirely, which would leave a configured retry no room to run.
const MAX_MODEL_TIMEOUT_MS = 20_000;
const MIN_CONTEXT_BUDGET_BYTES = 1_024;
// The context travels to the model over HTTP, not the 16 KiB UDP link, so this
// only needs to stay inside a sensible prompt size rather than a packet size.
const MAX_CONTEXT_BUDGET_BYTES = 512 * 1024;
const MIN_OUTPUT_TOKENS = 64;
const MAX_OUTPUT_TOKENS = 4_096;
const CONFIG_FIELDS = new Set([
  "host",
  "port",
  "language",
  "sampling_interval_ms",
  "provider",
  "model",
  "provider_url",
  "api_key",
  "model_timeout_ms",
  "model_retry_count",
  "context_budget_bytes",
  "max_output_tokens",
  "history_directory",
]);

export type AssistantLanguage = "zh-CN" | "en";
export type ProviderBackend = "local" | "openai-compatible" | "ollama";

export interface CompanionConfig {
  host: typeof LOOPBACK_HOST;
  port: number;
  language: AssistantLanguage;
  samplingIntervalMs: number;
  samplingIntervalTicks: number;
  provider: ProviderBackend;
  model: string;
  providerUrl: string;
  apiKey?: string;
  modelTimeoutMs: number;
  modelRetryCount: 0 | 1;
  contextBudgetBytes: number;
  maxOutputTokens: number;
  /** Where per-save production history is kept. */
  historyDirectory: string;
}

export interface LoadCompanionConfigOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

export async function loadCompanionConfig(
  options: LoadCompanionConfigOptions = {},
): Promise<CompanionConfig> {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? optionalEnvironmentValue(
    env,
    "FACTORIO_ASSISTANT_CONFIG",
  );
  let fileConfig: unknown = {};

  if (configPath !== undefined) {
    const metadata = await stat(configPath);
    if (metadata.size > MAX_CONFIG_BYTES) {
      throw new Error(
        `Companion config is ${metadata.size} bytes; maximum is ${MAX_CONFIG_BYTES}`,
      );
    }
    const encoded = await readFile(configPath);
    if (encoded.byteLength > MAX_CONFIG_BYTES) {
      throw new Error(
        `Companion config is ${encoded.byteLength} bytes; maximum is ${MAX_CONFIG_BYTES}`,
      );
    }

    try {
      fileConfig = JSON.parse(encoded.toString("utf8")) as unknown;
    } catch {
      throw new Error(`Companion config ${configPath} is not valid JSON`);
    }
  }

  return resolveCompanionConfig(fileConfig, env);
}

export function resolveCompanionConfig(
  input: unknown = {},
  env: NodeJS.ProcessEnv = {},
): CompanionConfig {
  const file = readConfigRecord(input);
  const host = readStringSetting(
    environmentOrFile(env, "FACTORIO_ASSISTANT_HOST", file.host),
    "host",
    LOOPBACK_HOST,
  );
  if (host !== LOOPBACK_HOST) {
    throw new Error(
      `Companion host must be ${LOOPBACK_HOST}; remote bind address ${host} is refused`,
    );
  }

  const port = parseCompanionPort(
    environmentOrFile(env, "FACTORIO_ASSISTANT_COMPANION_PORT", file.port),
  );
  const language = parseLanguage(
    environmentOrFile(env, "FACTORIO_ASSISTANT_LANGUAGE", file.language),
  );
  const samplingIntervalMs = readIntegerSetting(
    environmentOrFile(
      env,
      "FACTORIO_ASSISTANT_SAMPLING_INTERVAL_MS",
      file.sampling_interval_ms,
    ),
    "sampling_interval_ms",
    DEFAULT_SAMPLING_INTERVAL_MS,
    MIN_SAMPLING_INTERVAL_MS,
    MAX_SAMPLING_INTERVAL_MS,
  );
  if (samplingIntervalMs % 1_000 !== 0) {
    throw new Error("sampling_interval_ms must be a whole number of seconds");
  }
  const provider = parseProvider(
    environmentOrFile(env, "FACTORIO_ASSISTANT_PROVIDER", file.provider),
  );
  const model = readStringSetting(
    environmentOrFile(env, "FACTORIO_ASSISTANT_MODEL", file.model),
    "model",
    provider === "ollama" ? "llama3.2" : "gpt-4o-mini",
  );
  const providerUrl = parseProviderUrl(
    environmentOrFile(env, "FACTORIO_ASSISTANT_PROVIDER_URL", file.provider_url),
    provider,
  );
  const apiKey = readOptionalSecret(
    environmentOrFile(env, "FACTORIO_ASSISTANT_API_KEY", file.api_key),
    "api_key",
  );
  const modelTimeoutMs = readIntegerSetting(
    environmentOrFile(
      env,
      "FACTORIO_ASSISTANT_MODEL_TIMEOUT_MS",
      file.model_timeout_ms,
    ),
    "model_timeout_ms",
    DEFAULT_MODEL_TIMEOUT_MS,
    MIN_MODEL_TIMEOUT_MS,
    MAX_MODEL_TIMEOUT_MS,
  );
  const modelRetryCount = readIntegerSetting(
    environmentOrFile(
      env,
      "FACTORIO_ASSISTANT_MODEL_RETRY_COUNT",
      file.model_retry_count,
    ),
    "model_retry_count",
    1,
    0,
    1,
  ) as 0 | 1;
  const contextBudgetBytes = readIntegerSetting(
    environmentOrFile(
      env,
      "FACTORIO_ASSISTANT_CONTEXT_BUDGET_BYTES",
      file.context_budget_bytes,
    ),
    "context_budget_bytes",
    DEFAULT_CONTEXT_BUDGET_BYTES,
    MIN_CONTEXT_BUDGET_BYTES,
    MAX_CONTEXT_BUDGET_BYTES,
  );
  const maxOutputTokens = readIntegerSetting(
    environmentOrFile(
      env,
      "FACTORIO_ASSISTANT_MAX_OUTPUT_TOKENS",
      file.max_output_tokens,
    ),
    "max_output_tokens",
    1_600,
    MIN_OUTPUT_TOKENS,
    MAX_OUTPUT_TOKENS,
  );
  const historyDirectory = readStringSetting(
    environmentOrFile(
      env,
      "FACTORIO_ASSISTANT_HISTORY_DIR",
      file.history_directory,
    ),
    "history_directory",
    "history",
  );

  return {
    host: LOOPBACK_HOST,
    port,
    language,
    samplingIntervalMs,
    samplingIntervalTicks: Math.round((samplingIntervalMs * 60) / 1_000),
    provider,
    model,
    providerUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    modelTimeoutMs,
    modelRetryCount,
    contextBudgetBytes,
    maxOutputTokens,
    historyDirectory,
  };
}

export function parseCompanionPort(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_COMPANION_PORT;
  }

  return readIntegerSetting(value, "port", DEFAULT_COMPANION_PORT, 1, 65_535);
}

export function isLoopbackUrl(value: string): boolean {
  const url = new URL(value);
  return (
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]"
  );
}

function readConfigRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Companion config must be a JSON object");
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!CONFIG_FIELDS.has(key)) {
      throw new Error(`Unknown companion config field ${key}`);
    }
  }
  return record;
}

function environmentOrFile(
  env: NodeJS.ProcessEnv,
  environmentName: string,
  fileValue: unknown,
): unknown {
  return env[environmentName] ?? fileValue;
}

function optionalEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
}

function parseLanguage(value: unknown): AssistantLanguage {
  const language = readStringSetting(value, "language", "zh-CN");
  if (language !== "zh-CN" && language !== "en") {
    throw new Error("language must be zh-CN or en");
  }
  return language;
}

function parseProvider(value: unknown): ProviderBackend {
  const provider = readStringSetting(value, "provider", "local").toLowerCase();
  if (provider === "openclaw" || provider === "openai") {
    return "openai-compatible";
  }
  if (
    provider !== "local" &&
    provider !== "openai-compatible" &&
    provider !== "ollama"
  ) {
    throw new Error(
      "provider must be local, openai-compatible, openclaw, openai, or ollama",
    );
  }
  return provider;
}

function parseProviderUrl(value: unknown, provider: ProviderBackend): string {
  const fallback =
    provider === "ollama"
      ? "http://127.0.0.1:11434"
      : "http://127.0.0.1:18789/v1";
  const encoded = readStringSetting(value, "provider_url", fallback);
  let url: URL;

  try {
    url = new URL(encoded);
  } catch {
    throw new Error("provider_url must be an absolute HTTP(S) URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("provider_url must use http or https");
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("provider_url must not contain credentials, query, or fragment");
  }

  return url.toString().replace(/\/$/, "");
}

function readStringSetting(
  value: unknown,
  name: string,
  fallback: string,
): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (value.length > 2_048) {
    throw new Error(`${name} is too long`);
  }
  return value.trim();
}

function readOptionalSecret(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (value.length > 8_192) {
    throw new Error(`${name} is too long`);
  }
  return value.trim();
}

function readIntegerSetting(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    throw new Error(`${name} must be an integer`);
  }

  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}
