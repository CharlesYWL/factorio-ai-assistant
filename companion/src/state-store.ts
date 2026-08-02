import type {
  AreaSnapshotPacket,
  DynamicForceSummary,
  DynamicSnapshotPacket,
  MachineDescriptor,
  ModuleDescriptor,
  RecipeDescriptor,
  ResourceSnapshotPacket,
  StaticDeltaPacket,
  StaticForceDescriptor,
  StaticGameDescriptor,
  StaticSnapshotPacket,
  StaticSnapshotPayload,
} from "@factorio-ai-assistant/protocol";

const MAX_PENDING_SNAPSHOTS = 4;

export type StateSyncErrorCode = "REVISION_MISMATCH" | "SNAPSHOT_CONFLICT";

export class StateSyncError extends Error {
  public readonly code: StateSyncErrorCode;
  public readonly expectedRevision: number;

  public constructor(
    code: StateSyncErrorCode,
    message: string,
    expectedRevision: number,
  ) {
    super(message);
    this.name = "StateSyncError";
    this.code = code;
    this.expectedRevision = expectedRevision;
  }
}

export interface StaticState {
  snapshotId: string;
  revision: number;
  truncated: boolean;
  omittedRecords: number;
  game: StaticGameDescriptor;
  forces: StaticForceDescriptor[];
  recipes: RecipeDescriptor[];
  machines: MachineDescriptor[];
  modules: ModuleDescriptor[];
}

interface ForceState {
  researchedTechnologies: Set<string>;
  availableRecipes: Set<string>;
  productivityBonuses: Map<string, number>;
}

/**
 * Rebuilds one sample from its chunks. Each chunk repeats the force header and
 * carries a slice of that force's flows, so headers are taken from the first
 * chunk that mentions a force and the flow lists are concatenated in chunk
 * order. The result is byte-for-byte reproducible for a given set of chunks.
 */
function mergeDynamicChunks(
  pending: PendingDynamicSample,
): DynamicSnapshotPacket {
  const ordered = [...pending.chunks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, packet]) => packet);
  const first = ordered[0];
  if (first === undefined) {
    throw new Error("A completed dynamic sample must have at least one chunk");
  }

  const forces = new Map<string, DynamicForceSummary>();
  let omittedForces = 0;
  let omittedSeries = 0;
  let truncated = false;

  for (const packet of ordered) {
    omittedForces = Math.max(omittedForces, packet.payload.omitted_forces);
    omittedSeries = Math.max(omittedSeries, packet.payload.omitted_series);
    truncated = truncated || packet.payload.truncated;

    for (const force of packet.payload.forces) {
      const existing = forces.get(force.id);
      if (existing === undefined) {
        forces.set(force.id, {
          ...force,
          items: [...force.items],
          fluids: [...force.fluids],
        });
        continue;
      }
      existing.items.push(...force.items);
      existing.fluids.push(...force.fluids);
    }
  }

  return {
    ...first,
    payload: {
      ...first.payload,
      truncated,
      omitted_forces: omittedForces,
      omitted_series: omittedSeries,
      forces: [...forces.values()],
    },
  };
}

interface PendingAreaSelection {
  selectionId: number;
  chunkCount: number;
  chunks: Map<number, AreaSnapshotPacket>;
}

/** Rebuilds one selection from its chunks, concatenating entities in order. */
function mergeAreaChunks(pending: PendingAreaSelection): AreaSnapshotPacket {
  const ordered = [...pending.chunks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, packet]) => packet);
  const first = ordered[0];
  if (first === undefined) {
    throw new Error("A completed area selection must have at least one chunk");
  }

  return {
    ...first,
    payload: {
      ...first.payload,
      entities: ordered.flatMap((packet) => packet.payload.entities),
      groups: ordered.flatMap((packet) => packet.payload.groups),
      omitted_entities: Math.max(
        ...ordered.map((packet) => packet.payload.omitted_entities),
      ),
      truncated: ordered.some((packet) => packet.payload.truncated),
    },
  };
}

interface PendingDynamicSample {
  sampleSequence: number;
  chunkCount: number;
  chunks: Map<number, DynamicSnapshotPacket>;
}

interface PendingSnapshot {
  revision: number;
  chunkCount: number;
  truncated: boolean;
  omittedRecords: number;
  chunks: Map<number, StaticSnapshotPayload>;
}

export class CompanionStateStore {
  readonly #pendingSnapshots = new Map<string, PendingSnapshot>();
  /** Chunks of the dynamic sample currently being assembled, if any. */
  #pendingDynamic: PendingDynamicSample | undefined;
  /** Chunks of the area selection currently being assembled, if any. */
  #pendingArea: PendingAreaSelection | undefined;
  #areaSelection: AreaSnapshotPacket | undefined;
  #resources: ResourceSnapshotPacket | undefined;
  #staticState: StaticState | undefined;
  #dynamicState: DynamicSnapshotPacket | undefined;

  public get staticRevision(): number {
    return this.#staticState?.revision ?? 0;
  }

  public get staticState(): StaticState | undefined {
    return this.#staticState;
  }

  public get dynamicState(): DynamicSnapshotPacket | undefined {
    return this.#dynamicState;
  }

  /** The most recent area the player selected, if any. */
  public get areaSelection(): AreaSnapshotPacket | undefined {
    return this.#areaSelection;
  }

  /** Charted ore fields, refreshed slowly because ore does not move. */
  public get resources(): ResourceSnapshotPacket | undefined {
    return this.#resources;
  }

  public acceptResourceSnapshot(packet: ResourceSnapshotPacket): void {
    this.#resources = packet;
  }

  /**
   * Accepts one area datagram, reassembling a selection split across several.
   * Like dynamic samples these are unacked, so an incomplete selection is
   * discarded rather than shown as a smaller factory than the player selected.
   */
  public acceptAreaSnapshot(packet: AreaSnapshotPacket): void {
    const { chunk_count: chunkCount, chunk_index: chunkIndex } = packet.payload;
    const selection = packet.payload.selection_id;

    if (
      this.#areaSelection !== undefined &&
      selection < this.#areaSelection.payload.selection_id
    ) {
      return;
    }

    if (chunkCount === undefined || chunkIndex === undefined) {
      this.#pendingArea = undefined;
      this.#areaSelection = packet;
      return;
    }

    if (
      this.#pendingArea === undefined ||
      this.#pendingArea.selectionId !== selection
    ) {
      if (
        this.#pendingArea !== undefined &&
        selection < this.#pendingArea.selectionId
      ) {
        return;
      }
      this.#pendingArea = {
        selectionId: selection,
        chunkCount,
        chunks: new Map(),
      };
    }

    const pending = this.#pendingArea;
    if (pending.chunkCount !== chunkCount) {
      this.#pendingArea = undefined;
      return;
    }
    pending.chunks.set(chunkIndex, packet);
    if (pending.chunks.size < chunkCount) {
      return;
    }

    this.#pendingArea = undefined;
    this.#areaSelection = mergeAreaChunks(pending);
  }

  public acceptStaticSnapshotChunk(packet: StaticSnapshotPacket): boolean {
    const { payload } = packet;

    if (
      this.#staticState !== undefined &&
      payload.revision < this.#staticState.revision
    ) {
      return false;
    }

    if (
      this.#staticState !== undefined &&
      payload.revision === this.#staticState.revision
    ) {
      if (payload.snapshot_id !== this.#staticState.snapshotId) {
        throw this.#conflict(
          `Revision ${payload.revision} already belongs to snapshot ${this.#staticState.snapshotId}`,
        );
      }

      return false;
    }

    let pending = this.#pendingSnapshots.get(payload.snapshot_id);

    if (pending === undefined) {
      this.#discardOlderPending(payload.revision);

      if (this.#pendingSnapshots.size >= MAX_PENDING_SNAPSHOTS) {
        throw this.#conflict("Too many incomplete static snapshots");
      }

      pending = {
        revision: payload.revision,
        chunkCount: payload.chunk_count,
        truncated: payload.truncated,
        omittedRecords: payload.omitted_records,
        chunks: new Map(),
      };
      this.#pendingSnapshots.set(payload.snapshot_id, pending);
    } else {
      this.#assertConsistentChunk(pending, payload);
    }

    const priorChunk = pending.chunks.get(payload.chunk_index);
    if (priorChunk !== undefined) {
      if (JSON.stringify(priorChunk) !== JSON.stringify(payload)) {
        throw this.#conflict(
          `Static snapshot ${payload.snapshot_id} has conflicting chunk ${payload.chunk_index}`,
        );
      }

      return false;
    }

    pending.chunks.set(payload.chunk_index, payload);

    if (pending.chunks.size !== pending.chunkCount) {
      return false;
    }

    this.#staticState = assembleSnapshot(
      payload.snapshot_id,
      pending,
      this.staticRevision,
    );
    this.#pendingSnapshots.delete(payload.snapshot_id);
    this.#discardOlderPending(this.#staticState.revision + 1);
    return true;
  }

  public acceptStaticDelta(packet: StaticDeltaPacket): void {
    const { payload } = packet;

    if (
      this.#staticState !== undefined &&
      payload.revision <= this.#staticState.revision
    ) {
      return;
    }

    if (
      this.#staticState === undefined ||
      payload.base_revision !== this.#staticState.revision
    ) {
      throw new StateSyncError(
        "REVISION_MISMATCH",
        `Static delta starts at revision ${payload.base_revision}; companion has ${this.staticRevision}`,
        this.staticRevision,
      );
    }

    const forceMap = new Map(
      this.#staticState.forces.map((force) => [
        force.id,
        {
          researchedTechnologies: new Set(force.researched_technologies),
          availableRecipes: new Set(force.available_recipes),
          productivityBonuses: new Map(
            force.recipe_productivity_bonuses.map(({ recipe_id, bonus }) => [
              recipe_id,
              bonus,
            ]),
          ),
        },
      ]),
    );
    const forceState = forceMap.get(payload.force.id) ?? {
      researchedTechnologies: new Set<string>(),
      availableRecipes: new Set<string>(),
      productivityBonuses: new Map<string, number>(),
    };

    applySetDelta(
      forceState.researchedTechnologies,
      payload.force.researched_technologies_added,
      payload.force.researched_technologies_removed,
    );
    forceState.productivityBonuses = new Map(
      payload.force.recipe_productivity_bonuses.map(({ recipe_id, bonus }) => [
        recipe_id,
        bonus,
      ]),
    );
    applySetDelta(
      forceState.availableRecipes,
      payload.force.available_recipes_added,
      payload.force.available_recipes_removed,
    );
    forceMap.set(payload.force.id, forceState);

    this.#staticState = {
      ...this.#staticState,
      revision: payload.revision,
      forces: [...forceMap.entries()]
        .map(([id, state]) => ({
          id,
          researched_technologies: [...state.researchedTechnologies].sort(),
          available_recipes: [...state.availableRecipes].sort(),
          recipe_productivity_bonuses: [...state.productivityBonuses.entries()]
            .map(([recipe_id, bonus]) => ({ recipe_id, bonus }))
            .sort((left, right) => left.recipe_id.localeCompare(right.recipe_id)),
        }))
        .sort(compareById),
    };
  }

  /**
   * Accepts one dynamic datagram. A sample split across several datagrams is
   * only published once every chunk has arrived: unlike static snapshots there
   * is no retransmission, so a half-assembled sample would silently understate
   * production. A newer sample supersedes an incomplete older one.
   */
  public acceptDynamicSnapshot(packet: DynamicSnapshotPacket): void {
    const { chunk_count: chunkCount, chunk_index: chunkIndex } = packet.payload;
    const sequence = packet.payload.sample_sequence;

    // Late datagrams from a sample already replaced would otherwise start a new
    // pending assembly and overwrite fresher data with older flows.
    if (
      this.#dynamicState !== undefined &&
      sequence < this.#dynamicState.payload.sample_sequence
    ) {
      return;
    }

    if (chunkCount === undefined || chunkIndex === undefined) {
      this.#pendingDynamic = undefined;
      this.#dynamicState = packet;
      return;
    }

    if (
      this.#pendingDynamic === undefined ||
      this.#pendingDynamic.sampleSequence !== sequence
    ) {
      // A chunk from a different sample means the previous one will never
      // complete; drop it rather than mixing samples taken at different ticks.
      if (
        this.#pendingDynamic !== undefined &&
        sequence < this.#pendingDynamic.sampleSequence
      ) {
        return;
      }
      this.#pendingDynamic = {
        sampleSequence: sequence,
        chunkCount,
        chunks: new Map(),
      };
    }

    const pending = this.#pendingDynamic;
    if (pending.chunkCount !== chunkCount) {
      this.#pendingDynamic = undefined;
      return;
    }
    pending.chunks.set(chunkIndex, packet);
    if (pending.chunks.size < chunkCount) {
      return;
    }

    this.#pendingDynamic = undefined;
    this.#dynamicState = mergeDynamicChunks(pending);
  }

  #assertConsistentChunk(
    pending: PendingSnapshot,
    payload: StaticSnapshotPayload,
  ): void {
    if (
      pending.revision !== payload.revision ||
      pending.chunkCount !== payload.chunk_count ||
      pending.truncated !== payload.truncated ||
      pending.omittedRecords !== payload.omitted_records
    ) {
      throw this.#conflict(
        `Static snapshot ${payload.snapshot_id} has inconsistent chunk metadata`,
      );
    }
  }

  #discardOlderPending(revision: number): void {
    for (const [snapshotId, pending] of this.#pendingSnapshots) {
      if (pending.revision < revision) {
        this.#pendingSnapshots.delete(snapshotId);
      }
    }
  }

  #conflict(message: string): StateSyncError {
    return new StateSyncError(
      "SNAPSHOT_CONFLICT",
      message,
      this.staticRevision,
    );
  }
}

function assembleSnapshot(
  snapshotId: string,
  pending: PendingSnapshot,
  expectedRevision: number,
): StaticState {
  const forceMap = new Map<string, ForceState>();
  const recipeMap = new Map<string, RecipeDescriptor>();
  const machineMap = new Map<string, MachineDescriptor>();
  const moduleMap = new Map<string, ModuleDescriptor>();
  let game: StaticGameDescriptor | undefined;

  for (let index = 0; index < pending.chunkCount; index += 1) {
    const chunk = pending.chunks.get(index);
    if (chunk === undefined) {
      throw new StateSyncError(
        "SNAPSHOT_CONFLICT",
        `Static snapshot ${snapshotId} is missing chunk ${index}`,
        expectedRevision,
      );
    }

    if (chunk.game !== undefined) {
      if (game !== undefined && JSON.stringify(game) !== JSON.stringify(chunk.game)) {
        throw new StateSyncError(
          "SNAPSHOT_CONFLICT",
          `Static snapshot ${snapshotId} contains conflicting game descriptors`,
          expectedRevision,
        );
      }
      game = chunk.game;
    }

    for (const force of chunk.forces) {
      const current = forceMap.get(force.id) ?? {
        researchedTechnologies: new Set<string>(),
        availableRecipes: new Set<string>(),
        productivityBonuses: new Map<string, number>(),
      };

      addAll(current.researchedTechnologies, force.researched_technologies);
      addAll(current.availableRecipes, force.available_recipes);
      for (const { recipe_id, bonus } of force.recipe_productivity_bonuses) {
        const existing = current.productivityBonuses.get(recipe_id);
        if (existing !== undefined && existing !== bonus) {
          throw new StateSyncError(
            "SNAPSHOT_CONFLICT",
            `Static snapshot ${snapshotId} contains conflicting productivity bonus for ${recipe_id}`,
            expectedRevision,
          );
        }
        current.productivityBonuses.set(recipe_id, bonus);
      }
      forceMap.set(force.id, current);
    }

    for (const recipe of chunk.recipes) {
      addConsistentDescriptor(
        recipeMap,
        recipe,
        "recipe",
        snapshotId,
        expectedRevision,
      );
    }

    for (const machine of chunk.machines) {
      addConsistentDescriptor(
        machineMap,
        machine,
        "machine",
        snapshotId,
        expectedRevision,
      );
    }

    for (const module of chunk.modules) {
      addConsistentDescriptor(
        moduleMap,
        module,
        "module",
        snapshotId,
        expectedRevision,
      );
    }
  }

  if (game === undefined) {
    throw new StateSyncError(
      "SNAPSHOT_CONFLICT",
      `Static snapshot ${snapshotId} does not contain a game descriptor`,
      expectedRevision,
    );
  }

  return {
    snapshotId,
    revision: pending.revision,
    truncated: pending.truncated,
    omittedRecords: pending.omittedRecords,
    game,
    forces: [...forceMap.entries()]
      .map(([id, force]) => ({
        id,
        researched_technologies: [...force.researchedTechnologies].sort(),
        available_recipes: [...force.availableRecipes].sort(),
        recipe_productivity_bonuses: [...force.productivityBonuses.entries()]
          .map(([recipe_id, bonus]) => ({ recipe_id, bonus }))
          .sort((left, right) => left.recipe_id.localeCompare(right.recipe_id)),
      }))
      .sort(compareById),
    recipes: [...recipeMap.values()].sort(compareById),
    machines: [...machineMap.values()].sort(compareById),
    modules: [...moduleMap.values()].sort(compareById),
  };
}

function addAll(target: Set<string>, values: string[]): void {
  for (const value of values) {
    target.add(value);
  }
}

function applySetDelta(
  target: Set<string>,
  added: string[],
  removed: string[],
): void {
  for (const value of removed) {
    target.delete(value);
  }
  addAll(target, added);
}

function addConsistentDescriptor<T extends { id: string }>(
  target: Map<string, T>,
  descriptor: T,
  kind: string,
  snapshotId: string,
  expectedRevision: number,
): void {
  const existing = target.get(descriptor.id);

  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(descriptor)) {
    throw new StateSyncError(
      "SNAPSHOT_CONFLICT",
      `Static snapshot ${snapshotId} contains conflicting ${kind} ${descriptor.id}`,
      expectedRevision,
    );
  }

  target.set(descriptor.id, descriptor);
}

function compareById<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}
