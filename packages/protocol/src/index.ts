export const PROTOCOL_VERSION = 1 as const;
export const STATE_SCHEMA_VERSION = 2 as const;
export const MAX_PACKET_BYTES = 16 * 1024;

const MAX_ARRAY_ITEMS = 1_024;

export const ADVISOR_RULE_IDS = [
  "research-idle",
  "power-low",
  "lubricant-zero",
  "oil-imbalance",
  "robotics-stalled",
  "material-deficit",
  "production-decline",
] as const;
export const ADVISOR_SEVERITIES = ["info", "warning", "critical"] as const;
export const ADVISOR_EVENT_TYPES = ["opened", "reminder", "closed"] as const;

export type AdvisorRuleId = (typeof ADVISOR_RULE_IDS)[number];
export type AdvisorSeverity = (typeof ADVISOR_SEVERITIES)[number];
export type AdvisorEventType = (typeof ADVISOR_EVENT_TYPES)[number];

export interface AdvisorConfig {
  quiet_mode: boolean;
  muted_rules: AdvisorRuleId[];
  notification_cooldown_ticks: number;
  critical_power_bypass: boolean;
  recovery_ticks: number;
  research_idle_ticks: number;
  power_satisfaction_threshold: number;
  critical_power_threshold: number;
  power_low_ticks: number;
  lubricant_zero_ticks: number;
  oil_imbalance_ticks: number;
  oil_surplus_min_per_minute: number;
  petroleum_deficit_min_per_minute: number;
  science_stable_ticks: number;
  blue_science_min_per_minute: number;
  material_deficit_ratio: number;
  material_deficit_min_per_minute: number;
  material_deficit_ticks: number;
  crude_decline_ratio: number;
  crude_baseline_min_per_minute: number;
  crude_decline_ticks: number;
  key_material_baseline_min_per_minute: number;
  production_stop_ticks: number;
}

export const DEFAULT_ADVISOR_CONFIG: AdvisorConfig = {
  quiet_mode: false,
  muted_rules: [],
  notification_cooldown_ticks: 18_000,
  critical_power_bypass: true,
  recovery_ticks: 1_800,
  research_idle_ticks: 36_000,
  power_satisfaction_threshold: 0.9,
  critical_power_threshold: 0.5,
  power_low_ticks: 3_600,
  lubricant_zero_ticks: 36_000,
  oil_imbalance_ticks: 18_000,
  oil_surplus_min_per_minute: 60,
  petroleum_deficit_min_per_minute: 30,
  science_stable_ticks: 36_000,
  blue_science_min_per_minute: 15,
  material_deficit_ratio: 1.1,
  material_deficit_min_per_minute: 30,
  material_deficit_ticks: 18_000,
  crude_decline_ratio: 0.5,
  crude_baseline_min_per_minute: 60,
  crude_decline_ticks: 18_000,
  key_material_baseline_min_per_minute: 30,
  production_stop_ticks: 10_800,
};

export type ProtocolErrorCode =
  | "INVALID_ENCODING"
  | "PACKET_TOO_LARGE"
  | "INVALID_JSON"
  | "INVALID_PACKET"
  | "UNSUPPORTED_VERSION"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "UNSUPPORTED_TYPE";

export class ProtocolError extends Error {
  public readonly code: ProtocolErrorCode;

  public constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

function readOptionalNonNegativeNumber(
  value: unknown,
  path: string,
): number | undefined {
  return value === undefined ? undefined : readNonNegativeNumber(value, path);
}

export interface HelloPacket {
  protocol_version: typeof PROTOCOL_VERSION;
  message_id: string;
  type: "hello";
  tick: number;
  payload: {
    mod_version: string;
    advisor_config?: AdvisorConfig;
  };
}

export interface HelloAckPacket {
  protocol_version: typeof PROTOCOL_VERSION;
  message_id: string;
  type: "hello_ack";
  timestamp: number;
  payload: {
    reply_to: string;
    companion_version: string;
    static_revision?: number;
  };
}

export interface ModDescriptor {
  id: string;
  version: string;
}

export interface StaticGameDescriptor {
  version: string;
  mods: ModDescriptor[];
}

export interface StaticForceDescriptor {
  id: string;
  researched_technologies: string[];
  available_recipes: string[];
  recipe_productivity_bonuses: RecipeProductivityBonusDescriptor[];
}

export interface RecipeProductivityBonusDescriptor {
  recipe_id: string;
  bonus: number;
}

export interface RecipeComponent {
  kind: "item" | "fluid";
  id: string;
  amount: number;
  ignored_by_productivity?: number;
  temperature?: number;
  minimum_temperature?: number;
  maximum_temperature?: number;
}

export interface RecipeDescriptor {
  id: string;
  category: string;
  energy_seconds: number;
  ingredients: RecipeComponent[];
  products: RecipeComponent[];
  allowed_effects: string[];
  allowed_module_categories: string[];
  maximum_productivity: number;
}

export interface MachineDescriptor {
  id: string;
  kind: string;
  crafting_speed: number;
  crafting_categories: string[];
  module_slots: number;
  allowed_effects: string[];
  allowed_module_categories: string[];
}

export interface ModuleEffectsDescriptor {
  consumption?: number;
  speed?: number;
  productivity?: number;
  pollution?: number;
  quality?: number;
}

export interface ModuleDescriptor {
  id: string;
  category: string;
  effects: ModuleEffectsDescriptor;
}

export interface StaticSnapshotPayload {
  snapshot_id: string;
  revision: number;
  chunk_index: number;
  chunk_count: number;
  truncated: boolean;
  omitted_records: number;
  game?: StaticGameDescriptor;
  forces: StaticForceDescriptor[];
  recipes: RecipeDescriptor[];
  machines: MachineDescriptor[];
  modules: ModuleDescriptor[];
}

export interface StaticSnapshotPacket {
  protocol_version: typeof PROTOCOL_VERSION;
  schema_version: typeof STATE_SCHEMA_VERSION;
  message_id: string;
  type: "static_snapshot";
  tick: number;
  payload: StaticSnapshotPayload;
}

export interface StaticForceDelta {
  id: string;
  researched_technologies_added: string[];
  researched_technologies_removed: string[];
  available_recipes_added: string[];
  available_recipes_removed: string[];
  recipe_productivity_bonuses: RecipeProductivityBonusDescriptor[];
}

export interface StaticDeltaPacket {
  protocol_version: typeof PROTOCOL_VERSION;
  schema_version: typeof STATE_SCHEMA_VERSION;
  message_id: string;
  type: "static_delta";
  tick: number;
  payload: {
    base_revision: number;
    revision: number;
    force: StaticForceDelta;
  };
}

export interface FlowMetric {
  id: string;
  produced_per_minute_1m: number;
  consumed_per_minute_1m: number;
  produced_per_minute_10m: number;
  consumed_per_minute_10m: number;
}

export interface ResearchSummary {
  technology_id: string;
  progress: number;
}

export interface PowerSummary {
  network_count: number;
  generated_watts: number;
  consumed_watts: number;
  satisfaction_ratio: number;
}

export interface DynamicForceSummary {
  id: string;
  research: ResearchSummary | null;
  items: FlowMetric[];
  fluids: FlowMetric[];
  power: PowerSummary;
}

export interface DynamicSnapshotPacket {
  protocol_version: typeof PROTOCOL_VERSION;
  schema_version: typeof STATE_SCHEMA_VERSION;
  message_id: string;
  type: "dynamic_snapshot";
  tick: number;
  payload: {
    sample_interval_ticks: number;
    sample_sequence: number;
    truncated: boolean;
    omitted_forces: number;
    omitted_series: number;
    forces: DynamicForceSummary[];
  };
}

export interface StateAckPacket {
  protocol_version: typeof PROTOCOL_VERSION;
  schema_version: typeof STATE_SCHEMA_VERSION;
  message_id: string;
  type: "state_ack";
  timestamp: number;
  payload: {
    reply_to: string;
    revision: number;
  };
}

export interface ResyncRequestPacket {
  protocol_version: typeof PROTOCOL_VERSION;
  schema_version: typeof STATE_SCHEMA_VERSION;
  message_id: string;
  type: "resync_request";
  timestamp: number;
  payload: {
    expected_revision: number;
  };
}

export interface AdvisorAlert {
  id: string;
  rule_id: AdvisorRuleId;
  force_id: string;
  severity: AdvisorSeverity;
  evidence: string;
  recommendation: string;
  first_seen: number;
  last_seen: number;
}

export interface AdvisorUpdatePacket {
  protocol_version: typeof PROTOCOL_VERSION;
  schema_version: typeof STATE_SCHEMA_VERSION;
  message_id: string;
  type: "advisor_update";
  timestamp: number;
  payload: {
    event: AdvisorEventType;
    proactive: boolean;
    alert: AdvisorAlert;
  };
}

export type ProtocolPacket =
  | HelloPacket
  | HelloAckPacket
  | StaticSnapshotPacket
  | StaticDeltaPacket
  | DynamicSnapshotPacket
  | StateAckPacket
  | ResyncRequestPacket
  | AdvisorUpdatePacket;

interface HelloPacketInput {
  messageId: string;
  tick: number;
  modVersion: string;
  advisorConfig?: AdvisorConfig;
}

interface HelloAckPacketInput {
  messageId: string;
  replyTo: string;
  timestamp: number;
  companionVersion: string;
  staticRevision?: number;
}

interface StateAckPacketInput {
  messageId: string;
  replyTo: string;
  timestamp: number;
  revision: number;
}

interface ResyncRequestPacketInput {
  messageId: string;
  timestamp: number;
  expectedRevision: number;
}

interface AdvisorUpdatePacketInput {
  messageId: string;
  timestamp: number;
  event: AdvisorEventType;
  proactive: boolean;
  alert: AdvisorAlert;
}

export function createHelloPacket(input: HelloPacketInput): HelloPacket {
  return {
    protocol_version: PROTOCOL_VERSION,
    message_id: input.messageId,
    type: "hello",
    tick: input.tick,
    payload: {
      mod_version: input.modVersion,
      ...(input.advisorConfig === undefined
        ? {}
        : { advisor_config: input.advisorConfig }),
    },
  };
}

export function createHelloAckPacket(input: HelloAckPacketInput): HelloAckPacket {
  return {
    protocol_version: PROTOCOL_VERSION,
    message_id: input.messageId,
    type: "hello_ack",
    timestamp: input.timestamp,
    payload: {
      reply_to: input.replyTo,
      companion_version: input.companionVersion,
      ...(input.staticRevision === undefined
        ? {}
        : { static_revision: input.staticRevision }),
    },
  };
}

export function createStateAckPacket(input: StateAckPacketInput): StateAckPacket {
  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: input.messageId,
    type: "state_ack",
    timestamp: input.timestamp,
    payload: {
      reply_to: input.replyTo,
      revision: input.revision,
    },
  };
}

export function createResyncRequestPacket(
  input: ResyncRequestPacketInput,
): ResyncRequestPacket {
  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: input.messageId,
    type: "resync_request",
    timestamp: input.timestamp,
    payload: {
      expected_revision: input.expectedRevision,
    },
  };
}

export function createAdvisorUpdatePacket(
  input: AdvisorUpdatePacketInput,
): AdvisorUpdatePacket {
  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: input.messageId,
    type: "advisor_update",
    timestamp: input.timestamp,
    payload: {
      event: input.event,
      proactive: input.proactive,
      alert: input.alert,
    },
  };
}

export function encodePacket(packet: ProtocolPacket): string {
  let encoded: string;

  try {
    encoded = JSON.stringify(packet);
  } catch (error: unknown) {
    throw new ProtocolError(
      "INVALID_PACKET",
      `Packet cannot be serialized: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return JSON.stringify(decodePacket(encoded));
}

export function decodePacket(input: string | Uint8Array): ProtocolPacket {
  const text = decodeInput(input);
  const byteLength = new TextEncoder().encode(text).byteLength;

  if (byteLength > MAX_PACKET_BYTES) {
    throw new ProtocolError(
      "PACKET_TOO_LARGE",
      `Packet is ${byteLength} bytes; maximum is ${MAX_PACKET_BYTES}`,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProtocolError("INVALID_JSON", "Packet is not valid JSON");
  }

  const packet = readRecord(parsed, "packet");
  const version = readInteger(packet.protocol_version, "protocol_version");

  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      "UNSUPPORTED_VERSION",
      `Unsupported protocol_version ${version}; expected ${PROTOCOL_VERSION}`,
    );
  }

  const messageId = readMessageId(packet.message_id, "message_id");
  const type = readNonEmptyString(packet.type, "type");
  const payload = readRecord(packet.payload, "payload");

  switch (type) {
    case "hello":
      return decodeHello(packet, payload, messageId);
    case "hello_ack":
      return decodeHelloAck(packet, payload, messageId);
    case "static_snapshot":
      return decodeStaticSnapshot(packet, payload, messageId);
    case "static_delta":
      return decodeStaticDelta(packet, payload, messageId);
    case "dynamic_snapshot":
      return decodeDynamicSnapshot(packet, payload, messageId);
    case "state_ack":
      return decodeStateAck(packet, payload, messageId);
    case "resync_request":
      return decodeResyncRequest(packet, payload, messageId);
    case "advisor_update":
      return decodeAdvisorUpdate(packet, payload, messageId);
    default:
      throw new ProtocolError("UNSUPPORTED_TYPE", `Unsupported message type "${type}"`);
  }
}

function decodeHello(
  packet: Record<string, unknown>,
  payload: Record<string, unknown>,
  messageId: string,
): HelloPacket {
  const advisorConfig =
    payload.advisor_config === undefined
      ? undefined
      : readAdvisorConfig(payload.advisor_config, "payload.advisor_config");

  return {
    protocol_version: PROTOCOL_VERSION,
    message_id: messageId,
    type: "hello",
    tick: readNonNegativeInteger(packet.tick, "tick"),
    payload: {
      mod_version: readNonEmptyString(payload.mod_version, "payload.mod_version"),
      ...(advisorConfig === undefined ? {} : { advisor_config: advisorConfig }),
    },
  };
}

function decodeHelloAck(
  packet: Record<string, unknown>,
  payload: Record<string, unknown>,
  messageId: string,
): HelloAckPacket {
  const staticRevision = readOptionalNonNegativeInteger(
    payload.static_revision,
    "payload.static_revision",
  );

  return {
    protocol_version: PROTOCOL_VERSION,
    message_id: messageId,
    type: "hello_ack",
    timestamp: readNonNegativeInteger(packet.timestamp, "timestamp"),
    payload: {
      reply_to: readMessageId(payload.reply_to, "payload.reply_to"),
      companion_version: readNonEmptyString(
        payload.companion_version,
        "payload.companion_version",
      ),
      ...(staticRevision === undefined ? {} : { static_revision: staticRevision }),
    },
  };
}

function decodeStaticSnapshot(
  packet: Record<string, unknown>,
  payload: Record<string, unknown>,
  messageId: string,
): StaticSnapshotPacket {
  readStateSchemaVersion(packet);

  const chunkIndex = readNonNegativeInteger(
    payload.chunk_index,
    "payload.chunk_index",
  );
  const chunkCount = readPositiveInteger(payload.chunk_count, "payload.chunk_count");

  if (chunkIndex >= chunkCount) {
    throw invalidPacket("payload.chunk_index must be less than payload.chunk_count");
  }

  const game =
    payload.game === undefined
      ? undefined
      : readStaticGameDescriptor(payload.game, "payload.game");

  if (chunkIndex === 0 && game === undefined) {
    throw invalidPacket("payload.game is required in static snapshot chunk 0");
  }

  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: messageId,
    type: "static_snapshot",
    tick: readNonNegativeInteger(packet.tick, "tick"),
    payload: {
      snapshot_id: readMessageId(payload.snapshot_id, "payload.snapshot_id"),
      revision: readPositiveInteger(payload.revision, "payload.revision"),
      chunk_index: chunkIndex,
      chunk_count: chunkCount,
      truncated: readBoolean(payload.truncated, "payload.truncated"),
      omitted_records: readNonNegativeInteger(
        payload.omitted_records,
        "payload.omitted_records",
      ),
      ...(game === undefined ? {} : { game }),
      forces: readArray(payload.forces, "payload.forces", readStaticForceDescriptor),
      recipes: readArray(payload.recipes, "payload.recipes", readRecipeDescriptor),
      machines: readArray(payload.machines, "payload.machines", readMachineDescriptor),
      modules: readArray(payload.modules, "payload.modules", readModuleDescriptor),
    },
  };
}

function decodeStaticDelta(
  packet: Record<string, unknown>,
  payload: Record<string, unknown>,
  messageId: string,
): StaticDeltaPacket {
  readStateSchemaVersion(packet);

  const baseRevision = readNonNegativeInteger(
    payload.base_revision,
    "payload.base_revision",
  );
  const revision = readPositiveInteger(payload.revision, "payload.revision");

  if (revision !== baseRevision + 1) {
    throw invalidPacket("payload.revision must equal payload.base_revision + 1");
  }

  const force = readRecord(payload.force, "payload.force");

  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: messageId,
    type: "static_delta",
    tick: readNonNegativeInteger(packet.tick, "tick"),
    payload: {
      base_revision: baseRevision,
      revision,
      force: {
        id: readNonEmptyString(force.id, "payload.force.id"),
        researched_technologies_added: readStringArray(
          force.researched_technologies_added,
          "payload.force.researched_technologies_added",
        ),
        researched_technologies_removed: readStringArray(
          force.researched_technologies_removed,
          "payload.force.researched_technologies_removed",
        ),
        available_recipes_added: readStringArray(
          force.available_recipes_added,
          "payload.force.available_recipes_added",
        ),
        available_recipes_removed: readStringArray(
          force.available_recipes_removed,
          "payload.force.available_recipes_removed",
        ),
        recipe_productivity_bonuses: readArray(
          force.recipe_productivity_bonuses,
          "payload.force.recipe_productivity_bonuses",
          readRecipeProductivityBonusDescriptor,
        ),
      },
    },
  };
}

function decodeDynamicSnapshot(
  packet: Record<string, unknown>,
  payload: Record<string, unknown>,
  messageId: string,
): DynamicSnapshotPacket {
  readStateSchemaVersion(packet);

  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: messageId,
    type: "dynamic_snapshot",
    tick: readNonNegativeInteger(packet.tick, "tick"),
    payload: {
      sample_interval_ticks: readPositiveInteger(
        payload.sample_interval_ticks,
        "payload.sample_interval_ticks",
      ),
      sample_sequence: readNonNegativeInteger(
        payload.sample_sequence,
        "payload.sample_sequence",
      ),
      truncated: readBoolean(payload.truncated, "payload.truncated"),
      omitted_forces: readNonNegativeInteger(
        payload.omitted_forces,
        "payload.omitted_forces",
      ),
      omitted_series: readNonNegativeInteger(
        payload.omitted_series,
        "payload.omitted_series",
      ),
      forces: readArray(
        payload.forces,
        "payload.forces",
        readDynamicForceSummary,
        64,
      ),
    },
  };
}

function decodeStateAck(
  packet: Record<string, unknown>,
  payload: Record<string, unknown>,
  messageId: string,
): StateAckPacket {
  readStateSchemaVersion(packet);

  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: messageId,
    type: "state_ack",
    timestamp: readNonNegativeInteger(packet.timestamp, "timestamp"),
    payload: {
      reply_to: readMessageId(payload.reply_to, "payload.reply_to"),
      revision: readPositiveInteger(payload.revision, "payload.revision"),
    },
  };
}

function decodeResyncRequest(
  packet: Record<string, unknown>,
  payload: Record<string, unknown>,
  messageId: string,
): ResyncRequestPacket {
  readStateSchemaVersion(packet);

  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: messageId,
    type: "resync_request",
    timestamp: readNonNegativeInteger(packet.timestamp, "timestamp"),
    payload: {
      expected_revision: readNonNegativeInteger(
        payload.expected_revision,
        "payload.expected_revision",
      ),
    },
  };
}

function decodeAdvisorUpdate(
  packet: Record<string, unknown>,
  payload: Record<string, unknown>,
  messageId: string,
): AdvisorUpdatePacket {
  readStateSchemaVersion(packet);
  const event = readEnum(payload.event, "payload.event", ADVISOR_EVENT_TYPES);
  const proactive = readBoolean(payload.proactive, "payload.proactive");

  if (event === "closed" && proactive) {
    throw invalidPacket("payload.proactive must be false for a closed alert");
  }

  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: messageId,
    type: "advisor_update",
    timestamp: readNonNegativeInteger(packet.timestamp, "timestamp"),
    payload: {
      event,
      proactive,
      alert: readAdvisorAlert(payload.alert, "payload.alert"),
    },
  };
}

function readStaticGameDescriptor(value: unknown, path: string): StaticGameDescriptor {
  const record = readRecord(value, path);

  return {
    version: readNonEmptyString(record.version, `${path}.version`),
    mods: readArray(record.mods, `${path}.mods`, readModDescriptor),
  };
}

function readModDescriptor(value: unknown, path: string): ModDescriptor {
  const record = readRecord(value, path);

  return {
    id: readNonEmptyString(record.id, `${path}.id`),
    version: readNonEmptyString(record.version, `${path}.version`),
  };
}

function readStaticForceDescriptor(
  value: unknown,
  path: string,
): StaticForceDescriptor {
  const record = readRecord(value, path);

  return {
    id: readNonEmptyString(record.id, `${path}.id`),
    researched_technologies: readStringArray(
      record.researched_technologies,
      `${path}.researched_technologies`,
    ),
    available_recipes: readStringArray(
      record.available_recipes,
      `${path}.available_recipes`,
    ),
    recipe_productivity_bonuses: readArray(
      record.recipe_productivity_bonuses,
      `${path}.recipe_productivity_bonuses`,
      readRecipeProductivityBonusDescriptor,
    ),
  };
}

function readRecipeProductivityBonusDescriptor(
  value: unknown,
  path: string,
): RecipeProductivityBonusDescriptor {
  const record = readRecord(value, path);

  return {
    recipe_id: readNonEmptyString(record.recipe_id, `${path}.recipe_id`),
    bonus: readFiniteNumber(record.bonus, `${path}.bonus`),
  };
}

function readRecipeDescriptor(value: unknown, path: string): RecipeDescriptor {
  const record = readRecord(value, path);

  return {
    id: readNonEmptyString(record.id, `${path}.id`),
    category: readNonEmptyString(record.category, `${path}.category`),
    energy_seconds: readPositiveNumber(
      record.energy_seconds,
      `${path}.energy_seconds`,
    ),
    ingredients: readArray(
      record.ingredients,
      `${path}.ingredients`,
      readRecipeComponent,
      256,
    ),
    products: readArray(
      record.products,
      `${path}.products`,
      readRecipeComponent,
      256,
    ),
    allowed_effects: readStringArray(record.allowed_effects, `${path}.allowed_effects`),
    allowed_module_categories: readStringArray(
      record.allowed_module_categories,
      `${path}.allowed_module_categories`,
    ),
    maximum_productivity: readNonNegativeNumber(
      record.maximum_productivity,
      `${path}.maximum_productivity`,
    ),
  };
}

function readRecipeComponent(value: unknown, path: string): RecipeComponent {
  const record = readRecord(value, path);
  const kind = readEnum(record.kind, `${path}.kind`, ["item", "fluid"] as const);
  const temperature = readOptionalFiniteNumber(
    record.temperature,
    `${path}.temperature`,
  );
  const minimumTemperature = readOptionalFiniteNumber(
    record.minimum_temperature,
    `${path}.minimum_temperature`,
  );
  const maximumTemperature = readOptionalFiniteNumber(
    record.maximum_temperature,
    `${path}.maximum_temperature`,
  );
  const ignoredByProductivity = readOptionalNonNegativeNumber(
    record.ignored_by_productivity,
    `${path}.ignored_by_productivity`,
  );

  if (
    minimumTemperature !== undefined &&
    maximumTemperature !== undefined &&
    minimumTemperature > maximumTemperature
  ) {
    throw invalidPacket(
      `${path}.minimum_temperature must not exceed ${path}.maximum_temperature`,
    );
  }

  return {
    kind,
    id: readNonEmptyString(record.id, `${path}.id`),
    amount: readNonNegativeNumber(record.amount, `${path}.amount`),
    ...(ignoredByProductivity === undefined
      ? {}
      : { ignored_by_productivity: ignoredByProductivity }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(minimumTemperature === undefined
      ? {}
      : { minimum_temperature: minimumTemperature }),
    ...(maximumTemperature === undefined
      ? {}
      : { maximum_temperature: maximumTemperature }),
  };
}

function readMachineDescriptor(value: unknown, path: string): MachineDescriptor {
  const record = readRecord(value, path);

  return {
    id: readNonEmptyString(record.id, `${path}.id`),
    kind: readNonEmptyString(record.kind, `${path}.kind`),
    crafting_speed: readPositiveNumber(
      record.crafting_speed,
      `${path}.crafting_speed`,
    ),
    crafting_categories: readStringArray(
      record.crafting_categories,
      `${path}.crafting_categories`,
    ),
    module_slots: readNonNegativeInteger(record.module_slots, `${path}.module_slots`),
    allowed_effects: readStringArray(record.allowed_effects, `${path}.allowed_effects`),
    allowed_module_categories: readStringArray(
      record.allowed_module_categories,
      `${path}.allowed_module_categories`,
    ),
  };
}

function readModuleDescriptor(value: unknown, path: string): ModuleDescriptor {
  const record = readRecord(value, path);
  const effects = readRecord(record.effects, `${path}.effects`);

  return {
    id: readNonEmptyString(record.id, `${path}.id`),
    category: readNonEmptyString(record.category, `${path}.category`),
    effects: {
      ...readOptionalEffect(effects, "consumption", path),
      ...readOptionalEffect(effects, "speed", path),
      ...readOptionalEffect(effects, "productivity", path),
      ...readOptionalEffect(effects, "pollution", path),
      ...readOptionalEffect(effects, "quality", path),
    },
  };
}

function readOptionalEffect(
  effects: Record<string, unknown>,
  effect: keyof ModuleEffectsDescriptor,
  path: string,
): Partial<ModuleEffectsDescriptor> {
  const value = readOptionalFiniteNumber(effects[effect], `${path}.effects.${effect}`);
  return value === undefined ? {} : { [effect]: value };
}

function readDynamicForceSummary(
  value: unknown,
  path: string,
): DynamicForceSummary {
  const record = readRecord(value, path);

  return {
    id: readNonEmptyString(record.id, `${path}.id`),
    research:
      record.research === null
        ? null
        : readResearchSummary(record.research, `${path}.research`),
    items: readArray(record.items, `${path}.items`, readFlowMetric, 512),
    fluids: readArray(record.fluids, `${path}.fluids`, readFlowMetric, 512),
    power: readPowerSummary(record.power, `${path}.power`),
  };
}

function readResearchSummary(value: unknown, path: string): ResearchSummary {
  const record = readRecord(value, path);

  return {
    technology_id: readNonEmptyString(
      record.technology_id,
      `${path}.technology_id`,
    ),
    progress: readNumberInRange(record.progress, `${path}.progress`, 0, 1),
  };
}

function readFlowMetric(value: unknown, path: string): FlowMetric {
  const record = readRecord(value, path);

  return {
    id: readNonEmptyString(record.id, `${path}.id`),
    produced_per_minute_1m: readNonNegativeNumber(
      record.produced_per_minute_1m,
      `${path}.produced_per_minute_1m`,
    ),
    consumed_per_minute_1m: readNonNegativeNumber(
      record.consumed_per_minute_1m,
      `${path}.consumed_per_minute_1m`,
    ),
    produced_per_minute_10m: readNonNegativeNumber(
      record.produced_per_minute_10m,
      `${path}.produced_per_minute_10m`,
    ),
    consumed_per_minute_10m: readNonNegativeNumber(
      record.consumed_per_minute_10m,
      `${path}.consumed_per_minute_10m`,
    ),
  };
}

function readPowerSummary(value: unknown, path: string): PowerSummary {
  const record = readRecord(value, path);

  return {
    network_count: readNonNegativeInteger(
      record.network_count,
      `${path}.network_count`,
    ),
    generated_watts: readNonNegativeNumber(
      record.generated_watts,
      `${path}.generated_watts`,
    ),
    consumed_watts: readNonNegativeNumber(
      record.consumed_watts,
      `${path}.consumed_watts`,
    ),
    satisfaction_ratio: readNumberInRange(
      record.satisfaction_ratio,
      `${path}.satisfaction_ratio`,
      0,
      1,
    ),
  };
}

function readAdvisorConfig(value: unknown, path: string): AdvisorConfig {
  const record = readRecord(value, path);
  const powerSatisfactionThreshold = readNumberInRange(
    record.power_satisfaction_threshold,
    `${path}.power_satisfaction_threshold`,
    0,
    1,
  );
  const criticalPowerThreshold = readNumberInRange(
    record.critical_power_threshold,
    `${path}.critical_power_threshold`,
    0,
    1,
  );

  if (criticalPowerThreshold > powerSatisfactionThreshold) {
    throw invalidPacket(
      `${path}.critical_power_threshold must not exceed power_satisfaction_threshold`,
    );
  }

  const mutedRules = readArray(
    record.muted_rules,
    `${path}.muted_rules`,
    (item, itemPath) => readEnum(item, itemPath, ADVISOR_RULE_IDS),
    ADVISOR_RULE_IDS.length,
  );

  if (new Set(mutedRules).size !== mutedRules.length) {
    throw invalidPacket(`${path}.muted_rules must not contain duplicates`);
  }

  return {
    quiet_mode: readBoolean(record.quiet_mode, `${path}.quiet_mode`),
    muted_rules: mutedRules,
    notification_cooldown_ticks: readPositiveInteger(
      record.notification_cooldown_ticks,
      `${path}.notification_cooldown_ticks`,
    ),
    critical_power_bypass: readBoolean(
      record.critical_power_bypass,
      `${path}.critical_power_bypass`,
    ),
    recovery_ticks: readPositiveInteger(
      record.recovery_ticks,
      `${path}.recovery_ticks`,
    ),
    research_idle_ticks: readPositiveInteger(
      record.research_idle_ticks,
      `${path}.research_idle_ticks`,
    ),
    power_satisfaction_threshold: powerSatisfactionThreshold,
    critical_power_threshold: criticalPowerThreshold,
    power_low_ticks: readPositiveInteger(
      record.power_low_ticks,
      `${path}.power_low_ticks`,
    ),
    lubricant_zero_ticks: readPositiveInteger(
      record.lubricant_zero_ticks,
      `${path}.lubricant_zero_ticks`,
    ),
    oil_imbalance_ticks: readPositiveInteger(
      record.oil_imbalance_ticks,
      `${path}.oil_imbalance_ticks`,
    ),
    oil_surplus_min_per_minute: readNonNegativeNumber(
      record.oil_surplus_min_per_minute,
      `${path}.oil_surplus_min_per_minute`,
    ),
    petroleum_deficit_min_per_minute: readNonNegativeNumber(
      record.petroleum_deficit_min_per_minute,
      `${path}.petroleum_deficit_min_per_minute`,
    ),
    science_stable_ticks: readPositiveInteger(
      record.science_stable_ticks,
      `${path}.science_stable_ticks`,
    ),
    blue_science_min_per_minute: readNonNegativeNumber(
      record.blue_science_min_per_minute,
      `${path}.blue_science_min_per_minute`,
    ),
    material_deficit_ratio: readNumberInRange(
      record.material_deficit_ratio,
      `${path}.material_deficit_ratio`,
      1,
      10,
    ),
    material_deficit_min_per_minute: readNonNegativeNumber(
      record.material_deficit_min_per_minute,
      `${path}.material_deficit_min_per_minute`,
    ),
    material_deficit_ticks: readPositiveInteger(
      record.material_deficit_ticks,
      `${path}.material_deficit_ticks`,
    ),
    crude_decline_ratio: readNumberInRange(
      record.crude_decline_ratio,
      `${path}.crude_decline_ratio`,
      0,
      1,
    ),
    crude_baseline_min_per_minute: readNonNegativeNumber(
      record.crude_baseline_min_per_minute,
      `${path}.crude_baseline_min_per_minute`,
    ),
    crude_decline_ticks: readPositiveInteger(
      record.crude_decline_ticks,
      `${path}.crude_decline_ticks`,
    ),
    key_material_baseline_min_per_minute: readNonNegativeNumber(
      record.key_material_baseline_min_per_minute,
      `${path}.key_material_baseline_min_per_minute`,
    ),
    production_stop_ticks: readPositiveInteger(
      record.production_stop_ticks,
      `${path}.production_stop_ticks`,
    ),
  };
}

function readAdvisorAlert(value: unknown, path: string): AdvisorAlert {
  const record = readRecord(value, path);
  const id = readNonEmptyString(record.id, `${path}.id`, 512);
  const ruleId = readEnum(record.rule_id, `${path}.rule_id`, ADVISOR_RULE_IDS);
  const forceId = readNonEmptyString(record.force_id, `${path}.force_id`);
  const firstSeen = readNonNegativeInteger(record.first_seen, `${path}.first_seen`);
  const lastSeen = readNonNegativeInteger(record.last_seen, `${path}.last_seen`);

  if (id !== `${ruleId}:${forceId}`) {
    throw invalidPacket(`${path}.id must equal <rule_id>:<force_id>`);
  }

  if (lastSeen < firstSeen) {
    throw invalidPacket(`${path}.last_seen must not precede first_seen`);
  }

  return {
    id,
    rule_id: ruleId,
    force_id: forceId,
    severity: readEnum(record.severity, `${path}.severity`, ADVISOR_SEVERITIES),
    evidence: readNonEmptyString(record.evidence, `${path}.evidence`, 1_024),
    recommendation: readNonEmptyString(
      record.recommendation,
      `${path}.recommendation`,
      1_024,
    ),
    first_seen: firstSeen,
    last_seen: lastSeen,
  };
}

function readStateSchemaVersion(packet: Record<string, unknown>): void {
  const version = readInteger(packet.schema_version, "schema_version");

  if (version !== STATE_SCHEMA_VERSION) {
    throw new ProtocolError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `Unsupported schema_version ${version}; expected ${STATE_SCHEMA_VERSION}`,
    );
  }
}

function decodeInput(input: string | Uint8Array): string {
  if (typeof input === "string") {
    return input;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new ProtocolError("INVALID_ENCODING", "Packet is not valid UTF-8");
  }
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidPacket(`${path} must be a JSON object`);
  }

  return value as Record<string, unknown>;
}

function readArray<T>(
  value: unknown,
  path: string,
  readItem: (item: unknown, itemPath: string) => T,
  maximumLength = MAX_ARRAY_ITEMS,
): T[] {
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw invalidPacket(`${path} must be an array of at most ${maximumLength} items`);
  }

  return value.map((item, index) => readItem(item, `${path}[${index}]`));
}

function readStringArray(value: unknown, path: string): string[] {
  return readArray(value, path, readNonEmptyString);
}

function readMessageId(value: unknown, path: string): string {
  return readNonEmptyString(value, path, 128);
}

function readNonEmptyString(
  value: unknown,
  path: string,
  maximumLength = 256,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw invalidPacket(
      `${path} must be a non-empty string of at most ${maximumLength} characters`,
    );
  }

  return value;
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidPacket(`${path} must be a boolean`);
  }

  return value;
}

function readInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidPacket(`${path} must be a safe integer`);
  }

  return value;
}

function readNonNegativeInteger(value: unknown, path: string): number {
  const result = readInteger(value, path);

  if (result < 0) {
    throw invalidPacket(`${path} must be non-negative`);
  }

  return result;
}

function readOptionalNonNegativeInteger(
  value: unknown,
  path: string,
): number | undefined {
  return value === undefined ? undefined : readNonNegativeInteger(value, path);
}

function readPositiveInteger(value: unknown, path: string): number {
  const result = readInteger(value, path);

  if (result <= 0) {
    throw invalidPacket(`${path} must be positive`);
  }

  return result;
}

function readFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidPacket(`${path} must be a finite number`);
  }

  return value;
}

function readOptionalFiniteNumber(
  value: unknown,
  path: string,
): number | undefined {
  return value === undefined ? undefined : readFiniteNumber(value, path);
}

function readNonNegativeNumber(value: unknown, path: string): number {
  const result = readFiniteNumber(value, path);

  if (result < 0) {
    throw invalidPacket(`${path} must be non-negative`);
  }

  return result;
}

function readPositiveNumber(value: unknown, path: string): number {
  const result = readFiniteNumber(value, path);

  if (result <= 0) {
    throw invalidPacket(`${path} must be positive`);
  }

  return result;
}

function readNumberInRange(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  const result = readFiniteNumber(value, path);

  if (result < minimum || result > maximum) {
    throw invalidPacket(`${path} must be between ${minimum} and ${maximum}`);
  }

  return result;
}

function readEnum<const T extends readonly string[]>(
  value: unknown,
  path: string,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw invalidPacket(`${path} must be one of ${allowed.join(", ")}`);
  }

  return value;
}

function invalidPacket(message: string): ProtocolError {
  return new ProtocolError("INVALID_PACKET", message);
}
