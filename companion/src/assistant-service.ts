import { randomUUID } from "node:crypto";

import type { ProductionResult } from "@factorio-ai-assistant/calculator";

import type { AdvisorEngine } from "./advisor.js";
import type { CompanionConfig } from "./config.js";
import { isLoopbackUrl } from "./config.js";
import {
  buildCompactContext,
  type ContextSources,
} from "./context.js";
import {
  AssistantToolbox,
  formatGroundedAnswer,
  toAssistantToolModelContext,
  type AssistantGrounding,
} from "./assistant-tools.js";
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
const MAX_MODEL_INFERENCE_CHARACTERS = 1_000;

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
  readonly #toolbox: AssistantToolbox;

  public constructor(options: AssistantServiceOptions) {
    this.#config = options.config;
    this.#stateStore = options.stateStore;
    this.#advisor = options.advisor;
    this.#logger = options.logger;
    this.#toolbox = new AssistantToolbox(
      options.stateStore,
      options.advisor,
      options.config.language,
    );
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
    const grounding = this.#toolbox.ground(
      question,
      request.forceId,
      request.calculation,
    );
    const sources = this.#collectContext(request, grounding);
    const context = buildCompactContext(
      question,
      sources,
      this.#config.contextBudgetBytes,
    );

    if (grounding.evidence.length === 0) {
      return this.#localAnswer(
        requestId,
        grounding,
        this.#provider === undefined ? "local_mode" : "insufficient_data",
      );
    }

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
        const reconciled = reconcileModelInference(
          response.text,
          grounding,
        );
        if (reconciled.kind === "conflict") {
          this.#logger.warn("assistant_model_conflict", {
            request_id: requestId,
            provider: this.#provider.kind,
            conflict_type: reconciled.type,
          });
          return this.#localAnswer(requestId, grounding, "model_conflict");
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
          text: formatGroundedAnswer(
            this.#config.language,
            grounding,
            reconciled.text,
          ),
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
          grounding,
          providerError.code,
        );
      }
    }

    return this.#localAnswer(requestId, grounding, "local_mode");
  }

  #collectContext(
    request: AssistantRequest,
    grounding: AssistantGrounding,
  ): ContextSources {
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
      ...(grounding.calculation === undefined
        ? {}
        : { calculation: grounding.calculation }),
      toolContext: toAssistantToolModelContext(grounding),
    };
  }

  #localAnswer(
    requestId: string,
    grounding: AssistantGrounding,
    fallbackReason: string,
  ): AssistantAnswer {
    const text = formatGroundedAnswer(this.#config.language, grounding);
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

type ReconciledModelInference =
  | { kind: "ok"; text: string }
  | {
      kind: "conflict";
      type: "unsafe_command" | "citation" | "numeric" | "format";
    };

function reconcileModelInference(
  value: string,
  grounding: AssistantGrounding,
): ReconciledModelInference {
  if (containsExecutableInstruction(value)) {
    return { kind: "conflict", type: "unsafe_command" };
  }
  const text = normalizeModelInference(value);
  if (text.length === 0 || text.length > MAX_MODEL_INFERENCE_CHARACTERS) {
    return { kind: "conflict", type: "format" };
  }

  const evidenceIds = new Set(grounding.evidence.map(({ id }) => id));
  const citations = [...text.matchAll(/\[([A-Z]\d+)\]/g)].map(
    (match) => match[1] ?? "",
  );
  if (
    evidenceIds.size > 0 &&
    (citations.length === 0 ||
      citations.some((citation) => !evidenceIds.has(citation)))
  ) {
    return { kind: "conflict", type: "citation" };
  }

  if (containsUnsupportedNumber(text, grounding)) {
    return { kind: "conflict", type: "numeric" };
  }
  return { kind: "ok", text };
}

function containsExecutableInstruction(value: string): boolean {
  return /```|(?:^|\s)\/(?:c|sc|silent-command)\b|rcon\b|remote\.call|commands\.add_command|script\.on_|game\.[a-z_]|自动(?:建造|修改|拆除)|automatically (?:build|modify|remove)/imu.test(
    value,
  );
}

function normalizeModelInference(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) =>
      line
        .trim()
        .replace(/^#{1,6}\s*/u, "")
        .replace(/^(?:\d{1,2}[.)、]|[-*•])\s*/u, "")
        .trim(),
    )
    .filter(
      (line) =>
        line.length > 0 &&
        !/^(?:建议|结论|分析|recommendations?|conclusion)\s*[:：]?$/iu.test(
          line,
        ),
    )
    .slice(0, 3)
    .join("；")
    .replace(/\s+/g, " ")
    .trim();
}

function containsUnsupportedNumber(
  value: string,
  grounding: AssistantGrounding,
): boolean {
  const withoutCitations = value.replace(/\[[A-Z]\d+\]/g, "");
  const allowedNumbers = new Set(
    grounding.evidence.flatMap(({ text }) => extractArabicNumbers(text)),
  );
  const addsArabicNumber = extractArabicNumbers(withoutCitations).some(
    (number) => !allowedNumbers.has(number),
  );
  const addsChineseQuantity =
    /(?:百分之[零〇一二三四五六七八九十百千万两]+|[零〇一二三四五六七八九十百千万两]+(?:台|级|秒|分钟|小时|天|瓦|千瓦|兆瓦|吉瓦|成|倍|%|％))/u.test(
      withoutCitations,
    );
  return addsArabicNumber || addsChineseQuantity;
}

function extractArabicNumbers(value: string): string[] {
  return [...value.matchAll(/-?\d+(?:[.,]\d+)?%?/g)].map(
    (match) => match[0],
  );
}
