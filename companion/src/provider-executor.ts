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
}

export class ProviderExecutor {
  readonly #provider: AIProvider;
  readonly #timeoutMs: number;
  readonly #retryCount: 0 | 1;
  readonly #retryDelayMs: number;

  public constructor(provider: AIProvider, options: ProviderExecutorOptions) {
    this.#provider = provider;
    this.#timeoutMs = options.timeoutMs;
    this.#retryCount = options.retryCount;
    this.#retryDelayMs = options.retryDelayMs ?? 100;
  }

  public async complete(
    request: ProviderRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResponse> {
    for (let attempt = 0; attempt <= this.#retryCount; attempt += 1) {
      try {
        return await this.#completeAttempt(request, signal);
      } catch (error: unknown) {
        const providerError = normalizeProviderError(error, signal);
        if (!providerError.retryable || attempt === this.#retryCount) {
          throw providerError;
        }
        await wait(this.#retryDelayMs, signal);
      }
    }

    throw new ProviderError("unavailable", "Provider retry loop exhausted", false);
  }

  async #completeAttempt(
    request: ProviderRequest,
    parentSignal: AbortSignal | undefined,
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
          `Provider timed out after ${this.#timeoutMs} ms`,
          true,
        ),
      );
    }, this.#timeoutMs);

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
          `Provider timed out after ${this.#timeoutMs} ms`,
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
