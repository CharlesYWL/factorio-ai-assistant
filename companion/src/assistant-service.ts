import { randomUUID } from "node:crypto";

import type {
  AssistantHistoryTurn,
  HighlightMarker,
} from "@factorio-ai-assistant/protocol";

import type { AdvisorEngine } from "./advisor.js";
import type { AssistantLanguage, CompanionConfig } from "./config.js";
import { isLoopbackUrl } from "./config.js";
import { buildCompactContext, type ContextSources } from "./context.js";
import { ProductionHistory, summarizeTrend } from "./history.js";
import type { CompanionLogger } from "./logger.js";
import {
  IDENTIFIER_NAMES,
  type LocalizedNameLookup,
} from "./localization.js";
import { ProviderExecutor } from "./provider-executor.js";
import {
  executeRecipeTool,
  RECIPE_TOOLS,
  type ToolContext,
} from "./recipe-tools.js";
import {
  createConfiguredProvider,
  ProviderError,
  type AIProvider,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderToolTurn,
} from "./providers.js";

/** How many times the model may call tools before it must answer. */
const MAX_TOOL_ROUNDS = 3;
/**
 * Wall clock ceiling on the tool rounds. The final, tool-free call happens
 * after this, so the true worst case is this plus one provider budget — sized
 * to stay inside the Mod's own wait, or the answer would be discarded after
 * the player already paid for it.
 */
const MAX_TOOL_LOOP_MS = 120_000;
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
  /** Entities the answer asked to mark in the world. */
  markers?: HighlightMarker[];
}

export interface AssistantServiceOptions {
  config: CompanionConfig;
  stateStore: CompanionStateStore;
  advisor: AdvisorEngine;
  logger: CompanionLogger;
  provider?: AIProvider;
  localization?: LocalizedNameLookup;
  history?: ProductionHistory;
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
  readonly #history: ProductionHistory | undefined;

  public constructor(options: AssistantServiceOptions) {
    this.#config = options.config;
    this.#stateStore = options.stateStore;
    this.#advisor = options.advisor;
    this.#logger = options.logger;
    this.#names = options.localization ?? IDENTIFIER_NAMES;
    this.#history = options.history;
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

    const sources = this.#collectContext(request);
    const context = buildCompactContext(
      question,
      sources,
      this.#config.contextBudgetBytes,
    );
    this.#logContextBreakdown(requestId, context);

    // Tools are only offered when the catalog is present: without it the model
    // has no identifiers to look up, and would be guessing what to ask for.
    const toolsAvailable =
      this.#provider.kind === "openai-compatible" &&
      context["recipe_catalog"] !== undefined;

    const markers: HighlightMarker[] = [];

    try {
      const response = await this.#completeWithTools(
        {
          requestId,
          language: this.#config.language,
          question,
          context,
          ...(toolsAvailable ? { tools: RECIPE_TOOLS } : {}),
        },
        sources,
        markers,
        request.signal,
      );
      const text = response.text.trim();
      if (text.length === 0) {
        return this.#stateSummary(requestId, request, "empty_response");
      }
      const finalText = reconcileMarkerClaim(
        text,
        markers.length,
        this.#config.language,
        () =>
          this.#logger.warn("assistant_marker_claim_unmet", {
            request_id: requestId,
          }),
      );

      this.#logger.info("assistant_request_completed", {
        request_id: requestId,
        mode: "model",
        provider: this.#provider.kind,
        model: response.model,
        markers: markers.length,
      });
      return {
        requestId,
        mode: "model",
        text: finalText,
        provider: this.#provider.kind,
        model: response.model,
        ...(markers.length === 0 ? {} : { markers }),
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
    const trend =
      this.#history === undefined
        ? undefined
        : summarizeTrend(this.#history.points);

    return {
      ...(this.#stateStore.staticState === undefined
        ? {}
        : { staticState: this.#stateStore.staticState }),
      ...(dynamicForce === undefined ? {} : { dynamicForce }),
      ...(forceId === undefined ? {} : { forceId }),
      ...(this.#stateStore.areaSelection === undefined
        ? {}
        : { areaSelection: this.#stateStore.areaSelection }),
      ...(this.#stateStore.resources === undefined
        ? {}
        : { resources: this.#stateStore.resources }),
      ...(trend === undefined ? {} : { trend }),
      alerts: [...alerts],
      ...(request.history === undefined || request.history.length === 0
        ? {}
        : { history: request.history }),
      names: this.#names,
    };
  }

  /**
   * Runs the model, serving any tool calls it makes, until it answers in prose.
   *
   * The loop is bounded twice over. Rounds are capped because a model that keeps
   * calling tools would never answer, and each round replays the whole
   * transcript so they get progressively more expensive. There is also a wall
   * clock deadline, because the executor's budget applies per round: without it
   * four slow rounds could outlast what the Mod is willing to wait, and the
   * answer would be discarded after being paid for.
   */
  async #completeWithTools(
    request: ProviderRequest,
    sources: ContextSources,
    markers: HighlightMarker[],
    signal: AbortSignal | undefined,
  ): Promise<ProviderResponse> {
    const executor = this.#executor;
    if (executor === undefined) {
      throw new Error("completeWithTools requires a configured executor");
    }

    const toolContext: ToolContext = {
      staticState: sources.staticState,
      names: sources.names ?? IDENTIFIER_NAMES,
      ...(sources.forceId === undefined ? {} : { forceId: sources.forceId }),
      ...(sources.areaSelection === undefined
        ? {}
        : { areaSelection: sources.areaSelection }),
      markers,
    };
    const turns: ProviderToolTurn[] = [];
    const deadline = Date.now() + MAX_TOOL_LOOP_MS;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const response = await executor.complete(
        { ...request, toolTurns: turns },
        signal,
      );
      const calls = response.toolCalls ?? [];
      if (calls.length === 0) {
        return response;
      }

      // Out of rounds, or out of time: ask once more with no tools, so the
      // model has to answer from what it already looked up rather than failing
      // outright after the player has already waited.
      const outOfTime = Date.now() >= deadline;
      if (round === MAX_TOOL_ROUNDS || outOfTime) {
        this.#logger.warn("assistant_tool_rounds_exhausted", {
          request_id: request.requestId,
          rounds: round,
          reason: outOfTime ? "deadline" : "round_limit",
        });
        const retry: ProviderRequest = { ...request, toolTurns: turns };
        delete retry.tools;
        return executor.complete(retry, signal);
      }

      const results = calls.map((call) => {
        const output = executeRecipeTool(call.name, call.arguments, toolContext);
        const content = JSON.stringify(output);
        this.#logger.info("assistant_tool_call", {
          request_id: request.requestId,
          round,
          tool: call.name,
          arguments_bytes: call.arguments.length,
          result_bytes: content.length,
        });
        return { callId: call.id, name: call.name, content };
      });
      turns.push({ calls, results });
    }

    throw new Error("tool loop exited unexpectedly");
  }

  /**
   * Records what each section costs. Truncation is otherwise invisible: the
   * model simply answers from whatever survived the budget, so a section that
   * silently shrank looks the same as one that was never relevant.
   */
  #logContextBreakdown(
    requestId: string,
    context: Record<string, unknown>,
  ): void {
    const bytesOf = (value: unknown): number =>
      Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    const sections: Record<string, number> = {};
    for (const [key, value] of Object.entries(context)) {
      sections[`bytes_${key}`] = bytesOf(value);
    }

    const recipes = context["recipes"] as
      | { recipes?: unknown[]; truncated?: boolean }
      | undefined;
    const selection = context["selected_area"] as
      | { machines?: unknown[]; truncated?: boolean }
      | undefined;

    this.#logger.info("assistant_context_built", {
      request_id: requestId,
      total_bytes: bytesOf(context),
      budget_bytes: this.#config.contextBudgetBytes,
      ...sections,
      recipe_count: recipes?.recipes?.length ?? 0,
      recipes_truncated: recipes?.truncated ?? false,
      selected_machines: selection?.machines?.length ?? 0,
      selection_truncated: selection?.truncated ?? false,
    });
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

/**
 * Words a model reaches for when it claims to have marked something. Kept
 * deliberately narrow: matching "标记" alone would fire on a question about
 * circuit signals, and a false positive appends a correction to a correct
 * answer, which is worse than missing one claim.
 */
const MARKER_CLAIM_PATTERNS: readonly RegExp[] = [
  /已(?:在游戏内)?(?:标记|标注)/u,
  /(?:游戏内|地图上|世界里)已?(?:标记|标注)/u,
  /(?:标记|标注)(?:了|在)(?:游戏|地图)/u,
  /\bmarked (?:them |it |these |those )?(?:in[- ]game|on the map|in the world)/iu,
  /\b(?:I(?:'ve| have)? )?(?:marked|highlighted) (?:them|it|these|those)\b/iu,
];

/**
 * Stops an answer asserting a marker that was never drawn.
 *
 * The model can write "marked in-game" without ever calling the tool, and
 * nothing downstream would notice: the player reads the claim, looks at a map
 * with nothing on it, and reasonably concludes the feature is broken. Trusting
 * the tool call rather than the prose is the only reliable signal we have.
 */
export function reconcileMarkerClaim(
  text: string,
  markerCount: number,
  language: AssistantLanguage,
  onUnmet: () => void,
): string {
  if (markerCount > 0) {
    return text;
  }
  if (!MARKER_CLAIM_PATTERNS.some((pattern) => pattern.test(text))) {
    return text;
  }

  onUnmet();
  const note =
    language === "zh-CN"
      ? "（注意：本次没有实际标记任何位置，上文提到的「已标记」不成立。）"
      : "(Note: nothing was actually marked this time; the claim above does not hold.)";
  return `${text}\n\n${note}`;
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
