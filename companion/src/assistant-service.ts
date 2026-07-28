import { randomUUID } from "node:crypto";

import type { ProductionResult } from "@factorio-ai-assistant/calculator";

import type { AdvisorEngine } from "./advisor.js";
import type { CompanionConfig } from "./config.js";
import { isLoopbackUrl } from "./config.js";
import {
  buildCompactContext,
  type ContextSources,
} from "./context.js";
import type { CompanionLogger } from "./logger.js";
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
  calculation?: ProductionResult;
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
}

export class AssistantService {
  readonly #config: CompanionConfig;
  readonly #stateStore: CompanionStateStore;
  readonly #advisor: AdvisorEngine;
  readonly #logger: CompanionLogger;
  readonly #provider: AIProvider | undefined;
  readonly #executor: ProviderExecutor | undefined;

  public constructor(options: AssistantServiceOptions) {
    this.#config = options.config;
    this.#stateStore = options.stateStore;
    this.#advisor = options.advisor;
    this.#logger = options.logger;
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
            : "deterministic rules and calculator only",
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
    const sources = this.#collectContext(request);
    const context = buildCompactContext(
      question,
      sources,
      this.#config.contextBudgetBytes,
    );

    if (this.#executor !== undefined && this.#provider !== undefined) {
      try {
        const response = await this.#executor.complete(
          {
            requestId,
            language: this.#config.language,
            question,
            context,
          },
          request.signal,
        );
        this.#logger.info("assistant_request_completed", {
          request_id: requestId,
          mode: "model",
          provider: this.#provider.kind,
          model: response.model,
        });
        return {
          requestId,
          mode: "model",
          text: response.text,
          provider: this.#provider.kind,
          model: response.model,
        };
      } catch (error: unknown) {
        const providerError =
          error instanceof ProviderError
            ? error
            : new ProviderError(
                "unavailable",
                "Provider request failed",
                false,
              );
        if (providerError.code === "cancelled") {
          throw providerError;
        }
        this.#logger.warn("assistant_provider_fallback", {
          request_id: requestId,
          provider: this.#provider.kind,
          error_code: providerError.code,
          status: providerError.status,
        });
        return this.#localAnswer(
          requestId,
          sources,
          providerError.code,
        );
      }
    }

    return this.#localAnswer(requestId, sources, "local_mode");
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
      alerts,
      ...(request.calculation === undefined
        ? {}
        : { calculation: request.calculation }),
    };
  }

  #localAnswer(
    requestId: string,
    sources: ContextSources,
    fallbackReason: string,
  ): AssistantAnswer {
    const text = formatLocalAnswer(this.#config.language, sources);
    this.#logger.info("assistant_request_completed", {
      request_id: requestId,
      mode: "local",
      fallback_reason: fallbackReason,
    });
    return {
      requestId,
      mode: "local",
      text,
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

function formatLocalAnswer(
  language: CompanionConfig["language"],
  sources: ContextSources,
): string {
  const calculation = sources.calculation;
  if (calculation !== undefined) {
    const targets = calculation.targets
      .slice(0, 3)
      .map((target) => `${target.id} ${formatNumber(target.per_minute)}/min`)
      .join(", ");
    const recipes = calculation.recipes
      .slice(0, 5)
      .map(
        (recipe) =>
          `${recipe.recipe_id}: ${formatNumber(recipe.machines.exact)} ` +
          `(${recipe.machines.rounded_up} rounded up) ${recipe.machine_id}`,
      );
    return language === "zh-CN"
      ? [
          `本地确定性计算结果：${targets}。`,
          ...recipes.map((recipe) => `- ${recipe}`),
          `假设：${calculation.assumptions.rounding}`,
        ].join("\n")
      : [
          `Local deterministic calculation: ${targets}.`,
          ...recipes.map((recipe) => `- ${recipe}`),
          `Assumption: ${calculation.assumptions.rounding}`,
        ].join("\n");
  }

  const alerts = (sources.alerts ?? []).sort(compareAlerts).slice(0, 3);
  if (alerts.length > 0) {
    return language === "zh-CN"
      ? [
          "模型不可用；以下是本地规则给出的优先建议：",
          ...alerts.map(
            (alert, index) =>
              `${index + 1}. [${alert.severity}] ${alert.evidence} ${alert.recommendation}`,
          ),
        ].join("\n")
      : [
          "The model is unavailable; local rules found these priorities:",
          ...alerts.map(
            (alert, index) =>
              `${index + 1}. [${alert.severity}] ${alert.evidence} ${alert.recommendation}`,
          ),
        ].join("\n");
  }

  return language === "zh-CN"
    ? "当前为本地模式，模型不可用。本地规则未发现活动告警；精确比例计算和规则提醒仍可使用。"
    : "The companion is in local mode and no model is available. Local rules found no active alerts; deterministic calculations and alerts remain available.";
}

function compareAlerts(
  left: NonNullable<ContextSources["alerts"]>[number],
  right: NonNullable<ContextSources["alerts"]>[number],
): number {
  const rank = { critical: 0, warning: 1, info: 2 };
  return (
    rank[left.severity] - rank[right.severity] ||
    left.first_seen - right.first_seen
  );
}

function formatNumber(value: number): string {
  return String(Math.round(value * 1_000) / 1_000);
}
