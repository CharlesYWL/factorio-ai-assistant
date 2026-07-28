import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveCompanionConfig } from "./config.js";
import {
  MAX_PROVIDER_RESPONSE_BYTES,
  OllamaProvider,
  OpenAICompatibleProvider,
  ProviderError,
  createConfiguredProvider,
  type ProviderRequest,
} from "./providers.js";

const fixtureRequest: ProviderRequest = {
  requestId: "assistant-fixture",
  language: "zh-CN",
  question: "为什么缺电？",
  context: {
    power: {
      satisfaction_ratio: 0.42,
    },
  },
};

void test("sends and validates the OpenClaw/OpenAI-compatible fixture contract", async () => {
  const expectedRequest = JSON.parse(
    await readFile(
      new URL("../fixtures/openai-compatible-request.json", import.meta.url),
      "utf8",
    ),
  ) as unknown;
  const responseBody = await readFile(
    new URL("../fixtures/openai-compatible-response.json", import.meta.url),
    "utf8",
  );
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const mockFetch: typeof fetch = (input, init) => {
    capturedUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    capturedInit = init;
    return Promise.resolve(
      new Response(responseBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const provider = new OpenAICompatibleProvider({
    baseUrl: "http://127.0.0.1:18789/v1",
    model: "fixture-model",
    maxOutputTokens: 400,
    apiKey: "fixture-secret",
    fetchImplementation: mockFetch,
  });

  const response = await provider.complete(
    fixtureRequest,
    new AbortController().signal,
  );

  assert.equal(capturedUrl, "http://127.0.0.1:18789/v1/chat/completions");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(
    new Headers(capturedInit?.headers).get("authorization"),
    "Bearer fixture-secret",
  );
  assert.equal(
    new Headers(capturedInit?.headers).get("x-request-id"),
    fixtureRequest.requestId,
  );
  const encodedRequest = capturedInit?.body;
  if (typeof encodedRequest !== "string") {
    throw new Error("Expected a string OpenAI-compatible request body");
  }
  assert.deepEqual(JSON.parse(encodedRequest), expectedRequest);
  assert.deepEqual(response, {
    text: "当前电力满足率为 42%，请先增加发电并检查燃料供应。",
    model: "fixture-model",
    finishReason: "stop",
  });
});

void test("supports the Ollama local chat contract", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const mockFetch: typeof fetch = (_input, init) => {
    const encodedBody = init?.body;
    if (typeof encodedBody !== "string") {
      throw new Error("Expected a string Ollama request body");
    }
    capturedBody = JSON.parse(encodedBody) as Record<string, unknown>;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          model: "llama3.2",
          message: { role: "assistant", content: "Local answer" },
          done: true,
        }),
        { status: 200 },
      ),
    );
  };
  const provider = new OllamaProvider({
    baseUrl: "http://127.0.0.1:11434",
    model: "llama3.2",
    fetchImplementation: mockFetch,
  });

  const response = await provider.complete(
    { ...fixtureRequest, language: "en" },
    new AbortController().signal,
  );

  assert.equal(capturedBody?.model, "llama3.2");
  assert.equal(capturedBody?.stream, false);
  assert.equal(response.text, "Local answer");
  assert.equal(response.model, "llama3.2");
});

void test("rejects oversized and malformed provider responses", async () => {
  const oversizedFetch: typeof fetch = () =>
    Promise.resolve(
      new Response("x", {
        status: 200,
        headers: {
          "content-length": String(MAX_PROVIDER_RESPONSE_BYTES + 1),
        },
      }),
    );
  const provider = new OpenAICompatibleProvider({
    baseUrl: "http://127.0.0.1:18789/v1",
    model: "fixture-model",
    maxOutputTokens: 400,
    fetchImplementation: oversizedFetch,
  });

  await assert.rejects(
    provider.complete(fixtureRequest, new AbortController().signal),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.code === "invalid_response" &&
      !error.retryable,
  );

  const emptyProvider = new OpenAICompatibleProvider({
    baseUrl: "http://127.0.0.1:18789/v1",
    model: "fixture-model",
    maxOutputTokens: 400,
    fetchImplementation: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: "fixture-model",
            choices: [{ message: { content: " \n " } }],
          }),
        ),
      ),
  });
  await assert.rejects(
    emptyProvider.complete(fixtureRequest, new AbortController().signal),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_response",
  );
});

void test("classifies rate limits as retryable without exposing response bodies", async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    model: "fixture-model",
    maxOutputTokens: 400,
    apiKey: "fixture-secret",
    fetchImplementation: () =>
      Promise.resolve(
        new Response("sensitive upstream body", { status: 429 }),
      ),
  });

  await assert.rejects(
    provider.complete(fixtureRequest, new AbortController().signal),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.code === "rate_limited" &&
      error.retryable &&
      !error.message.includes("sensitive"),
  );
});

void test("does not enable an unauthenticated remote compatible endpoint", () => {
  const remote = resolveCompanionConfig(
    {
      provider: "openai-compatible",
      provider_url: "https://example.invalid/v1",
    },
    {},
  );
  const local = resolveCompanionConfig(
    {
      provider: "openclaw",
      provider_url: "http://127.0.0.1:18789/v1",
    },
    {},
  );

  assert.equal(createConfiguredProvider(remote), undefined);
  assert.equal(createConfiguredProvider(local)?.kind, "openai-compatible");
});
