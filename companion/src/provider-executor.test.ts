import assert from "node:assert/strict";
import test from "node:test";

import { ProviderExecutor } from "./provider-executor.js";
import {
  ProviderError,
  type AIProvider,
  type ProviderRequest,
} from "./providers.js";

const request: ProviderRequest = {
  requestId: "assistant-executor",
  language: "en",
  question: "What is wrong?",
  context: {},
};

void test("performs at most one bounded retry for retryable provider failures", async () => {
  let calls = 0;
  const provider: AIProvider = {
    kind: "openai-compatible",
    complete() {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(
          new ProviderError("rate_limited", "rate limited", true, 429),
        );
      }
      return Promise.resolve({ text: "Recovered", model: "mock" });
    },
  };
  const executor = new ProviderExecutor(provider, {
    timeoutMs: 1_000,
    retryCount: 1,
    retryDelayMs: 1,
  });

  assert.equal((await executor.complete(request)).text, "Recovered");
  assert.equal(calls, 2);
});

void test("does not retry invalid provider responses", async () => {
  let calls = 0;
  const provider: AIProvider = {
    kind: "ollama",
    complete() {
      calls += 1;
      return Promise.reject(
        new ProviderError("invalid_response", "bad schema", false),
      );
    },
  };
  const executor = new ProviderExecutor(provider, {
    timeoutMs: 1_000,
    retryCount: 1,
  });

  await assert.rejects(
    executor.complete(request),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_response",
  );
  assert.equal(calls, 1);
});

void test(
  "gives up on a timeout instead of waiting through a second one",
  { timeout: 2_000 },
  async () => {
    let calls = 0;
    const provider: AIProvider = {
      kind: "openai-compatible",
      complete() {
        calls += 1;
        return new Promise(() => undefined);
      },
    };
    const executor = new ProviderExecutor(provider, {
      timeoutMs: 20,
      retryCount: 1,
      retryDelayMs: 1,
    });

    await assert.rejects(
      executor.complete(request),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "timeout",
    );
    // A request that timed out is slow for a reason — usually a long answer —
    // so a second attempt would almost certainly time out as well and double
    // the wait for nothing.
    assert.equal(calls, 1);
  },
);

void test("propagates caller cancellation without retrying", async () => {
  let calls = 0;
  const provider: AIProvider = {
    kind: "ollama",
    complete() {
      calls += 1;
      return new Promise(() => undefined);
    },
  };
  const executor = new ProviderExecutor(provider, {
    timeoutMs: 1_000,
    retryCount: 1,
  });
  const controller = new AbortController();
  const completion = executor.complete(request, controller.signal);
  controller.abort();

  await assert.rejects(
    completion,
    (error: unknown) =>
      error instanceof ProviderError && error.code === "cancelled",
  );
  assert.equal(calls, 1);
});

void test(
  "caps a long per-attempt timeout with the total response budget",
  { timeout: 1_000 },
  async () => {
    let calls = 0;
    const provider: AIProvider = {
      kind: "openai-compatible",
      complete() {
        calls += 1;
        return new Promise(() => undefined);
      },
    };
    const executor = new ProviderExecutor(provider, {
      timeoutMs: 30_000,
      retryCount: 1,
      retryDelayMs: 10,
      totalTimeoutMs: 40,
    });
    const started = Date.now();

    await assert.rejects(
      executor.complete(request),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "timeout",
    );
    // The total budget, not the per-attempt timeout, is what ended this.
    assert.ok(Date.now() - started < 500);
    assert.equal(calls, 1);
  },
);
