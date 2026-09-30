import { INITIAL_THRESHOLDS, exceedsThreshold, parseParticleCount } from "./thresholds";
import type {
  Actor,
  Anomaly,
  AnomalyEvent,
  Batch,
  BatchItem,
  BatchItemReport,
  BatchResult,
  ConflictChoice,
  FieldKey,
  FieldState,
  FieldVersion,
  InspectionRecord,
  LegacyInput,
  MergeState,
  Shift,
  Team,
  ThresholdVersion,
} from "./types";

export const FIELD_KEYS: FieldKey[] = [
  "isoClass",
  "particleCount",
  "temperature",
  "humidity",
  "pressureDiff",
  "equipmentStatus",
  "handlingNote",
];

export function recordKeyOf(roomId: string, date: string, shift: Shift): string {
  return `${date}#${shift}#${roomId}`;
}

function emptyFields(): Record<FieldKey, FieldState> {
  return FIELD_KEYS.reduce(
    (acc, key) => {
      acc[key] = { accepted: null, candidates: [] };
      return acc;
    },
    {} as Record<FieldKey, FieldState>
  );
}

export function createInitialState(
  extraThresholds: ThresholdVersion[] = []
): MergeState {
  const thresholds: Record<number, ThresholdVersion> = {};
  for (const t of [...INITIAL_THRESHOLDS, ...extraThresholds]) {
    thresholds[t.version] = t;
  }
  return {
    records: {},
    anomalies: {},
    anomalyIndex: {},
    thresholds,
    currentThresholdVersion: 1,
    ledger: [],
    acceptedBatchIds: [],
    failedBatches: {},
  };
}

function clone(state: MergeState): MergeState {
  return structuredClone(state);
}

// ---------------------------------------------------------------------------
// 字段级合并：不同字段各自保留来源；同字段两班都改过且不一致 -> 待确认
// ---------------------------------------------------------------------------

interface MergeFieldResult {
  state: FieldState;
  /** incoming 是否成为/更新了生效版本，且生效值发生变化 */
  acceptedValueChanged: boolean;
  /** 是否产生了新的待确认冲突 */
  conflictRaised: boolean;
  /** 同班组更旧的写入到达，未覆盖当前较新的生效值 */
  staleIgnored: boolean;
}

export function mergeField(prev: FieldState, incoming: FieldVersion): MergeFieldResult {
  const wasConflict = prev.candidates.length >= 2;
  const oldAcceptedValue = prev.accepted?.value;

  // 同班更旧的补录（迟到的旧批次）不能冲掉较新的生效值
  if (
    !wasConflict &&
    prev.accepted &&
    prev.accepted.team === incoming.team &&
    incoming.editedAt < prev.accepted.editedAt &&
    prev.accepted.value !== incoming.value
  ) {
    return {
      state: prev,
      acceptedValueChanged: false,
      conflictRaised: false,
      staleIgnored: true,
    };
  }

  // 已在冲突中：候选列表为各班版本；否则以当前生效版本为基准
  const list: FieldVersion[] = wasConflict
    ? prev.candidates.map((c) => ({ ...c }))
    : prev.accepted
      ? [{ ...prev.accepted }]
      : [];

  const sameTeamIdx = list.findIndex((c) => c.team === incoming.team);
  if (sameTeamIdx >= 0) {
    // 同一班的更新覆盖自己的版本（同班补录不构成冲突）
    list[sameTeamIdx] = incoming;
  } else {
    list.push(incoming);
  }

  const distinctValues = new Set(list.map((c) => c.value));

  let next: FieldState;
  if (list.length >= 2 && distinctValues.size >= 2) {
    // 多班取值不一致 -> 停在待确认，列出各版
    let accepted = prev.accepted;
    if (accepted && accepted.team === incoming.team) accepted = incoming;
    if (!accepted || !list.some((c) => c.team === accepted!.team)) {
      accepted = list[0];
    }
    next = { accepted, candidates: list };
  } else {
    // 无人填 / 各班取值一致：以最新写入为生效版
    next = { accepted: incoming, candidates: [] };
  }

  return {
    state: next,
    acceptedValueChanged:
      next.accepted?.batchId === incoming.batchId &&
      oldAcceptedValue !== incoming.value,
    conflictRaised: !wasConflict && next.candidates.length >= 2,
    staleIgnored: false,
  };
}

// ---------------------------------------------------------------------------
// 异常状态机
// ---------------------------------------------------------------------------

function latestResolutionAt(anomaly: Anomaly): number {
  for (let i = anomaly.events.length - 1; i >= 0; i--) {
    if (anomaly.events[i].type === "resolve") return anomaly.events[i].at;
  }
  return -Infinity;
}

function latestDisposition(anomaly: Anomaly): string | undefined {
  for (let i = anomaly.events.length - 1; i >= 0; i--) {
    if (anomaly.events[i].type === "resolve") return anomaly.events[i].disposition;
  }
  return undefined;
}

function makeEvent(
  type: AnomalyEvent["type"],
  item: BatchItem,
  batch: Batch,
  detail: string,
  disposition?: string,
  actor?: Actor
): AnomalyEvent {
  return {
    type,
    at: type === "resolve" && disposition !== undefined ? item.editedAt : Date.now(),
    team: actor ?? item.team,
    batchId: batch.id,
    detail,
    disposition,
    thresholdVersion: item.thresholdVersion,
  };
}

function getOrCreateRecord(
  state: MergeState,
  item: BatchItem
): InspectionRecord | null {
  const key = recordKeyOf(item.roomId, item.date, item.shift);
  let record = state.records[key];
  const hasFields = item.fields && Object.keys(item.fields).length > 0;
  if (!record && !hasFields) return null; // 纯处置动作不凭空建巡检记录
  if (!record) {
    record = {
      id: key,
      roomId: item.roomId,
      date: item.date,
      shift: item.shift,
      isoClass: item.isoClass ?? null,
      fields: emptyFields(),
      revision: 0,
      judgedThresholdVersion: null,
      needsReconfirm: false,
      legacy: false,
      createdAt: item.editedAt,
      updatedAt: item.editedAt,
    };
    state.records[key] = record;
  }
  return record;
}

interface ParticleEvalInput {
  state: MergeState;
  record: InspectionRecord;
  item: BatchItem;
  batch: Batch;
  /**
   * 旧批次同班组的旧值虽不覆盖生效字段，仍按其携带值做一次判定，
   * 用于登记 ignored-stale；缺省按记录当前生效值判定。
   */
  incomingOverride?: { countRaw: string; editedAt: number; thresholdVersion: number };
  /** 事件归属操作人（角色裁决时传入） */
  actorOverride?: Actor;
}

/**
 * 用批次携带的阈值版本判定粒子计数。
 * 已处置异常的旧批次保护：
 *  - 已 resolved 且新计数再次超限（编辑时间晚于处置时间）-> reopened，原处置事件保留
 *  - 旧批次的计数 -> 不能改回待处理，登记 ignored-stale
 */
function evaluateParticle(
  input: ParticleEvalInput
): BatchItemReport["anomaly"] {
  const { state, record, item, batch, incomingOverride, actorOverride } = input;
  const key = record.id;
  const countRaw =
    incomingOverride?.countRaw ?? record.fields.particleCount.accepted?.value;
  const evaluateAt = incomingOverride?.editedAt ?? item.editedAt;
  const thresholdVersion =
    incomingOverride?.thresholdVersion ?? item.thresholdVersion;
  const isoClass = record.isoClass ?? item.isoClass ?? null;
  if (countRaw == null || isoClass == null) {
    return { action: "none", detail: "缺少粒子计数或洁净等级，未判定" };
  }
  if (parseParticleCount(countRaw) === null) {
    return { action: "none", detail: "粒子计数无法解析，未判定" };
  }

  const { exceeds, limit } = exceedsThreshold(
    state.thresholds,
    thresholdVersion,
    isoClass,
    countRaw
  );
  if (limit === null) {
    return { action: "none", detail: `未知洁净等级「${isoClass}」，未判定` };
  }
  // 记录生效粒子计数是按哪个阈值版本判定的（版本升级时据此标记复核）
  record.judgedThresholdVersion = thresholdVersion;
  if (thresholdVersion < state.currentThresholdVersion) {
    record.needsReconfirm = true;
  }
  const limitText = `限值 ${limit.toLocaleString()}（v${thresholdVersion}），实测 ${Number(
    countRaw
  ).toLocaleString()} 个/m³`;

  let anomaly = state.anomalyIndex[key]
    ? state.anomalies[state.anomalyIndex[key]]
    : null;

  if (!exceeds) {
    return {
      id: anomaly?.id,
      action: anomaly ? "normal" : "none",
      detail: anomaly
        ? `未超限但异常单为 ${anomaly.status}，保持人工处理；${limitText}`
        : `未超限；${limitText}`,
    };
  }

  if (!anomaly) {
    const id = `AX-${key}`;
    anomaly = {
      id,
      recordKey: key,
      roomId: record.roomId,
      status: "open",
      judgedThresholdVersion: thresholdVersion,
      needsReconfirm: thresholdVersion < state.currentThresholdVersion,
      events: [
        makeEvent("open", item, batch, `粒子计数超限：${limitText}`, undefined, actorOverride),
      ],
      createdAt: evaluateAt,
      updatedAt: Date.now(),
    };
    state.anomalies[id] = anomaly;
    state.anomalyIndex[key] = id;
    record.judgedThresholdVersion = thresholdVersion;
    return { id, action: "opened", detail: `新建异常并打开：${limitText}` };
  }

  if (anomaly.status === "open" || anomaly.status === "reopened") {
    anomaly.judgedThresholdVersion = thresholdVersion;
    anomaly.updatedAt = Date.now();
    record.judgedThresholdVersion = thresholdVersion;
    return {
      id: anomaly.id,
      action: "already-open",
      detail: `异常已为${anomaly.status === "open" ? "待处理" : "重开"}状态：${limitText}`,
    };
  }

  // status === resolved：关键保护逻辑
  const resolvedAt = latestResolutionAt(anomaly);
  if (evaluateAt <= resolvedAt) {
    anomaly.events.push(
      makeEvent(
        "ignored-stale",
        item,
        batch,
        `旧批次（${new Date(evaluateAt).toLocaleString("zh-CN")}）的超限计数早于处置时间，不能改回待处理：${limitText}`,
        undefined,
        actorOverride
      )
    );
    anomaly.updatedAt = Date.now();
    return {
      id: anomaly.id,
      action: "stale-ignored",
      detail: `旧批次不能把已处置异常改回待处理，已忽略：${limitText}`,
    };
  }

  const oldDisposition = latestDisposition(anomaly);
  anomaly.status = "reopened";
  anomaly.judgedThresholdVersion = thresholdVersion;
  anomaly.needsReconfirm = false;
  anomaly.events.push(
    makeEvent(
      "reopen",
      item,
      batch,
      `新批次粒子计数再次超限，异常重新打开；原处置保留：${oldDisposition ?? "无"}。${limitText}`,
      oldDisposition,
      actorOverride
    )
  );
  anomaly.updatedAt = Date.now();
  record.judgedThresholdVersion = item.thresholdVersion;
  return {
    id: anomaly.id,
    action: "reopened",
    detail: `新计数再次超限，异常重开，原处置保留：${limitText}`,
  };
}

function applyResolution(
  state: MergeState,
  record: InspectionRecord | null,
  item: BatchItem,
  batch: Batch
): BatchItemReport["anomaly"] {
  if (!record || !item.resolution) {
    return { action: "none", detail: "无异常可处置" };
  }
  const key = record.id;
  const anomalyId = state.anomalyIndex[key];
  const anomaly = anomalyId ? state.anomalies[anomalyId] : null;
  if (!anomaly) {
    // 兜底：处置批次携带 isoClass 且无异常单时无需动作
    return { action: "none", detail: "该房间班次尚无异常单，处置动作忽略" };
  }  const resolvedAt = latestResolutionAt(anomaly);
  if (anomaly.status === "resolved" && item.editedAt <= resolvedAt) {
    anomaly.events.push(
      makeEvent(
        "ignored-stale",
        item,
        batch,
        "旧批次的重复处置早于最近处置时间，忽略"
      )
    );
    return {
      id: anomaly.id,
      action: "resolve-stale-ignored",
      detail: "已处置异常忽略旧批次的重复处置",
    };
  }
  anomaly.status = "resolved";
  anomaly.needsReconfirm =
    anomaly.needsReconfirm ||
    anomaly.judgedThresholdVersion < state.currentThresholdVersion;
  anomaly.events.push(
    makeEvent(
      "resolve",
      item,
      batch,
      `班组处置关闭异常：${item.resolution.disposition}`,
      item.resolution.disposition
    )
  );
  anomaly.updatedAt = Date.now();
  return {
    id: anomaly.id,
    action: "resolved",
    detail: `异常已处置关闭：${item.resolution.disposition}`,
  };
}

// ---------------------------------------------------------------------------
// 批次接入：幂等台账 + 原子写入 + 单项合并
// ---------------------------------------------------------------------------

function validateItem(state: MergeState, item: BatchItem): string | null {
  if (!item.roomId?.trim()) return "缺少房间编号";
  if (!item.date?.trim()) return "缺少巡检日期";
  if (!item.shift) return "缺少班次";
  if (!item.team) return "缺少来源班组";
  if (!state.thresholds[item.thresholdVersion])
    return `阈值版本 v${item.thresholdVersion} 未知`;
  return null;
}

export function applyBatch(
  prev: MergeState,
  batch: Batch,
  opts?: { simulateError?: string }
): BatchResult {
  // 已接收批次不能重复带入（回网重放/重试去重）
  if (prev.acceptedBatchIds.includes(batch.id)) {
    const state = clone(prev);
    state.ledger.push({
      batchId: batch.id,
      label: batch.label,
      team: batch.team,
      outcome: "duplicate",
      at: Date.now(),
    });
    return { outcome: "duplicate", state, reports: [] };
  }

  for (const item of batch.items) {
    const err = validateItem(prev, item);
    if (err) {
      return failedResult(prev, batch, `批次校验失败：${err}`);
    }
  }

  if (opts?.simulateError) {
    // 模拟离线回网写入失败：整批不落库，可稍后单独重试
    return failedResult(prev, batch, opts.simulateError);
  }

  const state = clone(prev);
  const reports: BatchItemReport[] = [];
  const touchedKeys: string[] = [];

  for (const item of batch.items) {
    const record = getOrCreateRecord(state, item);
    const mergedFields: FieldKey[] = [];
    const conflictFields: FieldKey[] = [];
    let particleAcceptedChanged = false;
    let isoClassAcceptedChanged = false;
    let isNewRecord = false;
    let staleParticle:
      | { countRaw: string; editedAt: number; thresholdVersion: number }
      | undefined;

    if (record) {
      isNewRecord = record.revision === 0;
      for (const [key, rawValue] of Object.entries(item.fields ?? {})) {
        const field = key as FieldKey;
        if (rawValue == null || String(rawValue) === "") continue;
        const incoming: FieldVersion = {
          value: String(rawValue),
          team: item.team,
          batchId: batch.id,
          editedAt: item.editedAt,
          thresholdVersion: item.thresholdVersion,
          legacy: item.legacy === true,
        };
        const result = mergeField(record.fields[field], incoming);
        record.fields[field] = result.state;
        mergedFields.push(field);
        if (result.state.candidates.length >= 2) conflictFields.push(field);
        if (field === "particleCount" && result.acceptedValueChanged)
          particleAcceptedChanged = true;
        if (field === "isoClass" && result.acceptedValueChanged)
          isoClassAcceptedChanged = true;
        // 旧值不覆盖生效字段，但仍按其携带值判定一次异常（防回退登记）
        if (field === "particleCount" && result.staleIgnored) {
          particleAcceptedChanged = true;
          staleParticle = {
            countRaw: incoming.value,
            editedAt: incoming.editedAt,
            thresholdVersion: incoming.thresholdVersion,
          };
        }
      }
      if (mergedFields.length > 0) {
        record.revision += 1;
        record.updatedAt = Date.now();
        if (item.legacy) record.legacy = true;
        touchedKeys.push(record.id);
      }
      // 记录级洁净等级随生效字段更新
      const acceptedIso = record.fields.isoClass.accepted?.value ?? item.isoClass;
      if (acceptedIso) record.isoClass = acceptedIso;
    }

    let anomalyReport: BatchItemReport["anomaly"];
    if (record && (particleAcceptedChanged || isoClassAcceptedChanged)) {
      anomalyReport = evaluateParticle({
        state,
        record,
        item,
        batch,
        incomingOverride: staleParticle,
      });
    }
    // 同一项里既带字段又带处置（如旧数据迁移）：判定后应用处置
    if (record && item.resolution) {
      anomalyReport = applyResolution(state, record, item, batch);
    }

    reports.push({
      recordKey: record ? record.id : recordKeyOf(item.roomId, item.date, item.shift),
      isNewRecord,
      mergedFields,
      conflictFields,
      anomaly: anomalyReport,
    });
  }

  const wasFailed = !!prev.failedBatches[batch.id];
  delete state.failedBatches[batch.id];
  state.acceptedBatchIds.push(batch.id);
  state.ledger.push({
    batchId: batch.id,
    label: batch.label,
    team: batch.team,
    outcome: wasFailed ? "replayed" : "accepted",
    at: Date.now(),
    touchedRecordKeys: Array.from(new Set(touchedKeys)),
  });

  return { outcome: wasFailed ? "replayed" : "accepted", state, reports };
}

function failedResult(prev: MergeState, batch: Batch, error: string): BatchResult {
  const state = clone(prev);
  state.failedBatches[batch.id] = { batch, error };
  state.ledger.push({
    batchId: batch.id,
    label: batch.label,
    team: batch.team,
    outcome: "failed",
    at: Date.now(),
    error,
  });
  return { outcome: "failed", state, reports: [], error };
}

// ---------------------------------------------------------------------------
// 冲突裁决：人工从两版中选一（或给终版）后，立即重新做粒子判定
// ---------------------------------------------------------------------------

/** 角色操作在事件归属上落到当前记录班次（角色作为显示名由调用方传入） */
function actorToTeam(actor: Actor, fallback: Team): Team {
  return actor === "巡检员" || actor === "厂务工程师" || actor === "班组长"
    ? fallback
    : actor;
}

export function resolveConflict(
  prev: MergeState,
  choice: ConflictChoice,
  batch: Pick<Batch, "id">
): MergeState {
  const state = clone(prev);
  const record = state.records[choice.recordKey];
  if (!record) return state;
  const fieldState = record.fields[choice.field];
  if (fieldState.candidates.length < 2) return state;

  const chosen =
    choice.manualValue !== undefined
      ? ({
          value: choice.manualValue,
          team: actorToTeam(choice.decidedBy, record.shift),
          batchId: batch.id,
          editedAt: choice.decidedAt,
          thresholdVersion: state.currentThresholdVersion,
        } satisfies FieldVersion)
      : fieldState.candidates.find((c) => c.team === choice.chooseTeam) ?? null;
  if (!chosen) return state;

  record.fields[choice.field] = {
    accepted: { ...chosen },
    candidates: [],
  };
  if (choice.field === "isoClass") record.isoClass = chosen.value;
  record.revision += 1;
  record.updatedAt = Date.now();

  if (choice.field === "particleCount" || choice.field === "isoClass") {
    const pseudoItem: BatchItem = {
      roomId: record.roomId,
      date: record.date,
      shift: record.shift,
      team: actorToTeam(choice.decidedBy, record.shift),
      editedAt: choice.decidedAt,
      // 裁决发生在当下，按当前生效阈值版本重新判定（候选值的旧版本仅作来源元数据）
      thresholdVersion: state.currentThresholdVersion,
    };
    const report = evaluateParticle({
      state,
      record,
      item: pseudoItem,
      batch: { id: batch.id } as Batch,
      actorOverride: choice.decidedBy,
    });
    void report;
  }
  return state;
}

// ---------------------------------------------------------------------------
// 阈值版本升级：旧判定全部重新确认
// ---------------------------------------------------------------------------

export interface ReconfirmReport {
  recordKey: string;
  roomId: string;
  exceededUnderNew: boolean | null;
  action:
    | "reopened"
    | "remains-open"
    | "stays-resolved"
    | "normal"
    | "undeterminable";
  detail: string;
}

export function bumpThresholdVersion(
  prev: MergeState,
  nextVersion: ThresholdVersion
): { state: MergeState; reports: ReconfirmReport[] } {
  const state = clone(prev);
  state.thresholds[nextVersion.version] = nextVersion;
  state.currentThresholdVersion = nextVersion.version;

  const reports: ReconfirmReport[] = [];

  for (const record of Object.values(state.records)) {
    if (
      record.judgedThresholdVersion !== null &&
      record.judgedThresholdVersion < nextVersion.version
    ) {
      record.needsReconfirm = true;
    }
    const anomalyId = state.anomalyIndex[record.id];
    const anomaly = anomalyId ? state.anomalies[anomalyId] : null;
    if (anomaly && anomaly.judgedThresholdVersion < nextVersion.version) {
      anomaly.needsReconfirm = true;
    }

    if (!record.needsReconfirm) continue;

    // 自动按新阈值复核一遍（粒子计数与等级齐全时）
    const countRaw = record.fields.particleCount.accepted?.value;
    const isoClass = record.isoClass;
    if (!countRaw || !isoClass || parseParticleCount(countRaw) === null) {
      reports.push({
        recordKey: record.id,
        roomId: record.roomId,
        exceededUnderNew: null,
        action: "undeterminable",
        detail: "缺少生效的粒子计数/等级，保留待人工确认",
      });
      continue;
    }
    const { exceeds, limit } = exceedsThreshold(
      state.thresholds,
      nextVersion.version,
      isoClass,
      countRaw
    );
    if (limit === null) {
      reports.push({
        recordKey: record.id,
        roomId: record.roomId,
        exceededUnderNew: null,
        action: "undeterminable",
        detail: `未知等级「${isoClass}」，保留待人工确认`,
      });
      continue;
    }

    record.judgedThresholdVersion = nextVersion.version;
    record.needsReconfirm = false;
    const detail = `v${nextVersion.version - 1}→v${nextVersion.version} 复核：限值 ${limit.toLocaleString()}，实测 ${Number(
      countRaw
    ).toLocaleString()}`;

    if (!anomaly) {
      reports.push({
        recordKey: record.id,
        roomId: record.roomId,
        exceededUnderNew: exceeds,
        action: "normal",
        detail: exceeds
          ? `无异常单但新阈值下实测超限，转人工核查：${detail}`
          : `新阈值下合格，无需处理：${detail}`,
      });
      continue;
    }

    anomaly.judgedThresholdVersion = nextVersion.version;
    if (exceeds) {
      if (anomaly.status === "resolved") {
        anomaly.status = "reopened";
        const old = latestDisposition(anomaly);
        anomaly.events.push({
          type: "reconfirm",
          at: Date.now(),
          team: "夜班",
          detail: `阈值版本升级后重新判定仍超限，自动重开；原处置保留：${old ?? "无"}。${detail}`,
          disposition: old,
          thresholdVersion: nextVersion.version,
        });
        anomaly.needsReconfirm = false;
        reports.push({
          recordKey: record.id,
          roomId: record.roomId,
          exceededUnderNew: true,
          action: "reopened",
          detail: `仍超限，已处置异常自动重开（原处置保留）。${detail}`,
        });
      } else {
        anomaly.events.push({
          type: "reconfirm",
          at: Date.now(),
          team: "夜班",
          detail: `阈值版本升级后重新判定仍超限，维持打开。${detail}`,
          thresholdVersion: nextVersion.version,
        });
        anomaly.needsReconfirm = false;
        reports.push({
          recordKey: record.id,
          roomId: record.roomId,
          exceededUnderNew: true,
          action: "remains-open",
          detail,
        });
      }
    } else {
      anomaly.events.push({
        type: "reconfirm",
        at: Date.now(),
        team: "夜班",
        detail:
          anomaly.status === "open"
            ? `阈值版本升级后不再超限，待人工确认后关闭。${detail}`
            : `阈值版本升级后维持已关闭。${detail}`,
        thresholdVersion: nextVersion.version,
      });
      if (anomaly.status !== "open") anomaly.needsReconfirm = false;
      reports.push({
        recordKey: record.id,
        roomId: record.roomId,
        exceededUnderNew: false,
        action: anomaly.status === "open" ? "remains-open" : "stays-resolved",
        detail:
          anomaly.status === "open"
            ? `新阈值下不超限，待人工关闭。${detail}`
            : `新阈值下不超限，维持关闭。${detail}`,
      });
    }
  }

  return { state, reports };
}

/** 人工复核单条旧判定记录 */
export function reconfirmRecord(
  prev: MergeState,
  recordKey: string,
  decision: { stillExceeds: boolean; note: string; team: Actor; at: number }
): MergeState {
  const state = clone(prev);
  const record = state.records[recordKey];
  if (!record) return state;
  const version = state.currentThresholdVersion;
  record.judgedThresholdVersion = version;
  record.needsReconfirm = false;

  const anomalyId = state.anomalyIndex[recordKey];
  const anomaly = anomalyId ? state.anomalies[anomalyId] : null;
  if (anomaly) {
    anomaly.judgedThresholdVersion = version;
    anomaly.needsReconfirm = false;
    if (decision.stillExceeds) {
      if (anomaly.status === "resolved") {
        anomaly.status = "reopened";
        anomaly.events.push({
          type: "reconfirm",
          at: decision.at,
          team: decision.team,
          detail: `人工复核确认仍超限，重开异常（原处置保留）。${decision.note}`,
          disposition: latestDisposition(anomaly),
          thresholdVersion: version,
        });
      } else {
        anomaly.events.push({
          type: "reconfirm",
          at: decision.at,
          team: decision.team,
          detail: `人工复核确认仍超限，维持打开。${decision.note}`,
          thresholdVersion: version,
        });
      }
    } else if (anomaly.status === "open") {
      anomaly.status = "resolved";
      anomaly.events.push({
        type: "resolve",
        at: decision.at,
        team: decision.team,
        detail: `人工复核确认合格，关闭异常。${decision.note}`,
        disposition: decision.note,
        thresholdVersion: version,
      });
    } else {
      anomaly.events.push({
        type: "reconfirm",
        at: decision.at,
        team: decision.team,
        detail: `人工复核确认合格，维持关闭。${decision.note}`,
        thresholdVersion: version,
      });
    }
  }
  return state;
}

/** 看板上直接处置异常 */
export function resolveAnomaly(
  prev: MergeState,
  anomalyId: string,
  disposition: string,
  team: Actor,
  at: number
): MergeState {
  const state = clone(prev);
  const anomaly = state.anomalies[anomalyId];
  if (!anomaly || anomaly.status === "resolved") return state;
  anomaly.status = "resolved";
  anomaly.needsReconfirm =
    anomaly.judgedThresholdVersion < state.currentThresholdVersion;
  anomaly.events.push({
    type: "resolve",
    at,
    team,
    detail: `人工处置关闭异常：${disposition}`,
    disposition,
    thresholdVersion: anomaly.judgedThresholdVersion,
  });
  anomaly.updatedAt = at;
  return state;
}

// ---------------------------------------------------------------------------
// 旧浏览器数据迁移：补上班次与阈值版本，历史处置仍可查
// ---------------------------------------------------------------------------

export function migrateLegacy(
  prev: MergeState,
  legacy: LegacyInput[]
): BatchResult {
  const items: BatchItem[] = legacy.map((row) => ({
    roomId: row.roomId,
    date: row.date,
    shift: row.shift,
    team: row.shift,
    editedAt: row.capturedAt,
    thresholdVersion: row.thresholdVersion,
    isoClass: row.fields?.isoClass,
    fields: row.fields,
    legacy: true,
    resolution: row.pastDisposition
      ? { disposition: `[历史处置] ${row.pastDisposition.note}` }
      : undefined,
  }));

  // 处置时间需要用旧时间戳，逐项构造并改写 resolution 的 editedAt
  const batch: Batch = {
    id: `MIGRATION:${legacy
      .map((r) => `${r.roomId}|${r.date}|${r.shift}`)
      .sort()
      .join(",")}`,
    label: "旧浏览器数据迁移（补班次+阈值版本）",
    team: "早班",
    createdAt: Date.now(),
    items,
  };

  const result = applyBatch(prev, batch);
  if (result.outcome !== "accepted" && result.outcome !== "replayed") {
    return result;
  }
  // 把历史处置事件时间校正为真实旧时间，open 事件保持采集时间
  const state = result.state;
  for (const row of legacy) {
    if (!row.pastDisposition) continue;
    const key = recordKeyOf(row.roomId, row.date, row.shift);
    const anomalyId = state.anomalyIndex[key];
    const anomaly = anomalyId ? state.anomalies[anomalyId] : null;
    const event = anomaly?.events.find(
      (e) => e.batchId === batch.id && e.type === "resolve"
    );
    if (event) event.at = row.pastDisposition.disposedAt;
  }
  return { ...result, state };
}
