import { randomUUID } from "node:crypto";

import type { AssistantHistoryTurn } from "@factorio-ai-assistant/protocol";

import type { AdvisorEngine } from "./advisor.js";
import type { CompanionConfig } from "./config.js";
import { isLoopbackUrl } from "./config.js";
import { buildCompactContext, type ContextSources } from "./context.js";
import type { CompanionLogger } from "./logger.js";
import {
  IDENTIFIER_NAMES,
  type LocalizedNameLookup,
} from "./localization.js";
import { ProviderExecutor } from "./provider-executor.js";
import {
  createConfiguredProvider,
  ProviderError,
  type AIProvider,
} from "./providers.js";
import type { CompanionStateStore } from "./state-store.js";

export const MAX_QUESTION_BYTES = 4_096;
export const MAX_QUESTION_CHARACTERS = 2_000;

export type AssistantMode = "local" | "local-model" | "remote-model";

export interface AssistantStatus {
  mode: AssistantMode;
  provider: CompanionConfig["provider"];
  model: string | null;
  reason: string;
}

export interface AssistantRequest {
  question: string;
  forceId?: string;
  /**
   * The asking player's own recent turns, supplied by the Mod when that player
   * opted in, so a follow-up like "那它呢" can be understood.
   */
  history?: readonly AssistantHistoryTurn[];
  signal?: AbortSignal;
}

export interface AssistantAnswer {
  requestId: string;
  mode: "model" | "local";
  text: string;
  provider?: AIProvider["kind"];
  model?: string;
  fallbackReason?: string;
}

export interface AssistantServiceOptions {
  config: CompanionConfig;
  stateStore: CompanionStateStore;
  advisor: AdvisorEngine;
  logger: CompanionLogger;
  provider?: AIProvider;
  localization?: LocalizedNameLookup;
}

/**
 * Answers player questions by handing the model the data it cannot know —
 * this save's recipes and current state — and letting it reason.
 *
 * The Companion does not classify the question, parse it, or check the answer.
 * Earlier versions did all three with regular expressions and rejected any
 * answer whose numbers were not copied verbatim from precomputed evidence;
 * that misread ordinary questions and discarded correct answers. The remaining
 * responsibility here is to supply accurate, save-specific data.
 */
export class AssistantService {
  readonly #config: CompanionConfig;
  readonly #stateStore: CompanionStateStore;
  readonly #advisor: AdvisorEngine;
  readonly #logger: CompanionLogger;
  readonly #provider: AIProvider | undefined;
  readonly #executor: ProviderExecutor | undefined;
  readonly #names: LocalizedNameLookup;

  public constructor(options: AssistantServiceOptions) {
    this.#config = options.config;
    this.#stateStore = options.stateStore;
    this.#advisor = options.advisor;
    this.#logger = options.logger;
    this.#names = options.localization ?? IDENTIFIER_NAMES;
    this.#provider =
      options.provider ?? createConfiguredProvider(options.config);
    this.#executor =
      this.#provider === undefined
        ? undefined
        : new ProviderExecutor(this.#provider, {
            timeoutMs: options.config.modelTimeoutMs,
            retryCount: options.config.modelRetryCount,
          });
  }

  public get status(): AssistantStatus {
    if (this.#provider === undefined) {
      return {
        mode: "local",
        provider: this.#config.provider,
        model: null,
        reason:
          this.#config.provider === "openai-compatible" &&
          this.#config.apiKey === undefined &&
          !isLoopbackUrl(this.#config.providerUrl)
            ? "remote provider credentials are not configured"
            : "deterministic rules and deterministic calculations only",
      };
    }

    return {
      mode: isLoopbackUrl(this.#config.providerUrl)
        ? "local-model"
        : "remote-model",
      provider: this.#config.provider,
      model: this.#config.model,
      reason: isLoopbackUrl(this.#config.providerUrl)
        ? "model endpoint is on this machine"
        : "remote model endpoint is configured",
    };
  }

  public async answer(request: AssistantRequest): Promise<AssistantAnswer> {
    const question = validateQuestion(request.question);
    const requestId = `assistant-${randomUUID()}`;

    if (this.#executor === undefined || this.#provider === undefined) {
      return this.#stateSummary(requestId, request, "no_model_configured");
    }

    const context = buildCompactContext(
      question,
      this.#collectContext(request),
      this.#config.contextBudgetBytes,
    );

    try {
      const response = await this.#executor.complete(
        { requestId, language: this.#config.language, question, context },
        request.signal,
      );
      const text = response.text.trim();
      if (text.length === 0) {
        return this.#stateSummary(requestId, request, "empty_response");
      }

      this.#logger.info("assistant_request_completed", {
        request_id: requestId,
        mode: "model",
        provider: this.#provider.kind,
        model: response.model,
      });
      return {
        requestId,
        mode: "model",
        text,
        provider: this.#provider.kind,
        model: response.model,
      };
    } catch (error: unknown) {
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError("unavailable", "Provider request failed", false);
      if (providerError.code === "cancelled") {
        throw providerError;
      }
      this.#logger.warn("assistant_provider_fallback", {
        request_id: requestId,
        provider: this.#provider.kind,
        error_code: providerError.code,
        status: providerError.status,
      });
      return this.#stateSummary(requestId, request, providerError.code);
    }
  }

  #collectContext(request: AssistantRequest): ContextSources {
    const dynamicForces = this.#stateStore.dynamicState?.payload.forces ?? [];
    const dynamicForce =
      request.forceId === undefined
        ? dynamicForces[0]
        : dynamicForces.find(({ id }) => id === request.forceId);
    const forceId = dynamicForce?.id ?? request.forceId;
    const alerts =
      forceId === undefined
        ? this.#advisor.activeAlerts
        : this.#advisor.activeAlerts.filter(
            (alert) => alert.force_id === forceId,
          );

    return {
      ...(this.#stateStore.staticState === undefined
        ? {}
        : { staticState: this.#stateStore.staticState }),
      ...(dynamicForce === undefined ? {} : { dynamicForce }),
      ...(forceId === undefined ? {} : { forceId }),
      ...(this.#stateStore.areaSelection === undefined
        ? {}
        : { areaSelection: this.#stateStore.areaSelection }),
      alerts: [...alerts],
      ...(request.history === undefined || request.history.length === 0
        ? {}
        : { history: request.history }),
      names: this.#names,
    };
  }

  /**
   * What can still be said when the model is unavailable: the deterministic
   * alerts and the headline live numbers, with no attempt to answer.
   */
  #stateSummary(
    requestId: string,
    request: AssistantRequest,
    fallbackReason: string,
  ): AssistantAnswer {
    const chinese = this.#config.language === "zh-CN";
    const lines: string[] = [
      chinese
        ? "模型暂时不可用，下面是当前可以确定的状态。"
        : "The model is unavailable; here is the state that is known for certain.",
    ];

    const forces = this.#stateStore.dynamicState?.payload.forces ?? [];
    const force =
      request.forceId === undefined
        ? forces[0]
        : forces.find(({ id }) => id === request.forceId);

    if (force !== undefined) {
      const satisfaction = Math.round(force.power.satisfaction_ratio * 100);
      lines.push(
        chinese
          ? `电力满足率 ${satisfaction}%。`
          : `Power satisfaction is ${satisfaction}%.`,
      );
    }

    const alerts = this.#advisor.activeAlerts
      .filter(
        (alert) => force === undefined || alert.force_id === force.id,
      )
      .slice(0, 3);
    for (const alert of alerts) {
      lines.push(`- ${alert.evidence}`);
    }
    if (alerts.length === 0) {
      lines.push(chinese ? "当前没有活动告警。" : "No alerts are active.");
    }

    this.#logger.info("assistant_request_completed", {
      request_id: requestId,
      mode: "local",
      fallback_reason: fallbackReason,
    });
    return {
      requestId,
      mode: "local",
      text: lines.join("\n"),
      fallbackReason,
    };
  }
}

export class AssistantInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AssistantInputError";
  }
}

export function validateQuestion(value: string): string {
  if (typeof value !== "string") {
    throw new AssistantInputError("Question must be a string");
  }

  const question = value.trim();
  if (question.length === 0) {
    throw new AssistantInputError("Question must not be empty");
  }
  if (question.length > MAX_QUESTION_CHARACTERS) {
    throw new AssistantInputError(
      `Question exceeds ${MAX_QUESTION_CHARACTERS} characters`,
    );
  }
  if (Buffer.byteLength(question, "utf8") > MAX_QUESTION_BYTES) {
    throw new AssistantInputError(
      `Question exceeds ${MAX_QUESTION_BYTES} UTF-8 bytes`,
    );
  }
  if (containsDisallowedControl(question)) {
    throw new AssistantInputError("Question contains disallowed control characters");
  }
  return question;
}

function containsDisallowedControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code === 127 ||
      (code < 32 && code !== 9 && code !== 10 && code !== 13)
    ) {
      return true;
    }
  }
  return false;
}
