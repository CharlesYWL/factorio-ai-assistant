import {
  ProviderError,
  type AIProvider,
  type ProviderRequest,
  type ProviderResponse,
} from "./providers.js";

export interface ProviderExecutorOptions {
  timeoutMs: number;
  retryCount: 0 | 1;
  retryDelayMs?: number;
  totalTimeoutMs?: number;
}

export const MAX_PROVIDER_TOTAL_WAIT_MS = 30_000;

export class ProviderExecutor {
  readonly #provider: AIProvider;
  readonly #timeoutMs: number;
  readonly #retryCount: 0 | 1;
  readonly #retryDelayMs: number;
  readonly #totalTimeoutMs: number;

  public constructor(provider: AIProvider, options: ProviderExecutorOptions) {
    this.#provider = provider;
    this.#timeoutMs = options.timeoutMs;
    this.#retryCount = options.retryCount;
    this.#retryDelayMs = options.retryDelayMs ?? 100;
    this.#totalTimeoutMs =
      options.totalTimeoutMs ?? MAX_PROVIDER_TOTAL_WAIT_MS;
  }

  public async complete(
    request: ProviderRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResponse> {
    const deadline = Date.now() + this.#totalTimeoutMs;
    for (let attempt = 0; attempt <= this.#retryCount; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw totalTimeout(this.#totalTimeoutMs);
      }
      try {
        return await this.#completeAttempt(
          request,
          signal,
          Math.min(this.#timeoutMs, remainingMs),
        );
      } catch (error: unknown) {
        const providerError = normalizeProviderError(error, signal);
        if (!providerError.retryable || attempt === this.#retryCount) {
          throw providerError;
        }
        const retryBudgetMs = deadline - Date.now();
        if (retryBudgetMs <= this.#retryDelayMs) {
          throw totalTimeout(this.#totalTimeoutMs);
        }
        await wait(this.#retryDelayMs, signal);
      }
    }

    throw new ProviderError("unavailable", "Provider retry loop exhausted", false);
  }

  async #completeAttempt(
    request: ProviderRequest,
    parentSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<ProviderResponse> {
    if (parentSignal?.aborted === true) {
      throw cancelled();
    }

    const controller = new AbortController();
    let timedOut = false;
    let parentAborted = false;
    let rejectBoundary: ((error: ProviderError) => void) | undefined;
    const boundary = new Promise<never>((_resolve, reject) => {
      rejectBoundary = reject;
    });
    const onParentAbort = (): void => {
      parentAborted = true;
      controller.abort(parentSignal?.reason);
      rejectBoundary?.(cancelled());
    };
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectBoundary?.(
        new ProviderError(
          "timeout",
          `Provider timed out after ${timeoutMs} ms`,
          true,
        ),
      );
    }, timeoutMs);

    try {
      return await Promise.race([
        this.#provider.complete(request, controller.signal),
        boundary,
      ]);
    } catch (error: unknown) {
      if (parentAborted) {
        throw cancelled();
      }
      if (timedOut) {
        throw new ProviderError(
          "timeout",
          `Provider timed out after ${timeoutMs} ms`,
          true,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }
}

function normalizeProviderError(
  error: unknown,
  signal: AbortSignal | undefined,
): ProviderError {
  if (signal?.aborted === true) {
    return cancelled();
  }
  if (error instanceof ProviderError) {
    return error;
  }
  if (error instanceof TypeError) {
    return new ProviderError("unavailable", "Provider network request failed", true);
  }
  return new ProviderError("unavailable", "Provider request failed", false);
}

function cancelled(): ProviderError {
  return new ProviderError("cancelled", "Provider request was cancelled", false);
}

function totalTimeout(milliseconds: number): ProviderError {
  return new ProviderError(
    "timeout",
    `Provider exceeded the ${milliseconds} ms total response budget`,
    false,
  );
}

function wait(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(cancelled());
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
