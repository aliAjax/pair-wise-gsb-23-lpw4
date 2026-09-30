// 巡检记录合并 + 异常联动引擎（纯函数，不依赖 React / 浏览器）
import {
  AuditEvent,
  ConflictVersion,
  DomainState,
  ExceptionEvent,
  ExceptionRecord,
  FieldConflict,
  FieldKey,
  FieldValue,
  InspectionRecord,
  ParticleJudgment,
  RecordWriteOp,
  RoomClass,
  Source,
  SyncBatch,
  ThresholdVersion,
  exceptionKey,
  recordKey,
} from "./types";

export const NUMERIC_FIELDS: ReadonlySet<FieldKey> = new Set([
  "particleCount",
  "temperature",
  "humidity",
  "pressureDiff",
]);

const ROOM_CLASSES: RoomClass[] = ["ISO 5", "ISO 6", "ISO 7", "黄光区"];

export function createDomainState(
  thresholds: ThresholdVersion[],
  currentVersion: string,
  now = Date.now()
): DomainState {
  if (!thresholds.some((t) => t.version === currentVersion)) {
    throw new Error("当前阈值版本不存在");
  }
  return {
    records: {},
    exceptions: {},
    thresholds: Object.fromEntries(thresholds.map((t) => [t.version, t])),
    currentThresholdVersion: currentVersion,
    ledger: [],
    audit: [],
    seq: 0,
  };
}

function nextId(d: DomainState, prefix: string): string {
  d.seq += 1;
  return `${prefix}-${String(d.seq).padStart(4, "0")}`;
}

function audit(d: DomainState, kind: AuditEvent["kind"], message: string, at: number) {
  d.audit.unshift({ id: nextId(d, "aud"), at, kind, message });
  if (d.audit.length > 200) d.audit.length = 200;
}

function makeSource(b: SyncBatch, receivedAt: number): Source {
  return {
    batchId: b.batchId,
    terminal: b.terminal,
    operator: b.operator,
    shift: b.shift,
    at: b.preparedAt,
    receivedAt,
    thresholdVersion: b.thresholdVersion,
    legacy: b.legacy,
  };
}

function normalizeValue(field: FieldKey, raw: string | number): string | number {
  if (NUMERIC_FIELDS.has(field)) {
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) throw new Error(`字段 ${field} 不是数字`);
    return n;
  }
  return String(raw).trim();
}

function valueEquals(a: string | number, b: string | number): boolean {
  if (typeof a === "number" || typeof b === "number") {
    return Number(a) === Number(b);
  }
  return a.trim() === b.trim();
}

export interface BatchResult {
  outcome: "accepted" | "duplicate" | "failed";
  error?: string;
  /** 本批打开/新增的待确认冲突（供界面提示） */
  conflictIds: string[];
}

/**
 * 接收一个回网批次：
 * 1. 已接收批次按 batchId 去重，绝不重复带入；
 * 2. 失败（含 persist 抛错）只登记台账，不改动数据，之后可用同一 batchId 单独重试；
 * 3. 字段级合并：不同字段各留来源，同字段并发修改停在待确认并列出两版。
 */
export function receiveBatch(
  state: DomainState,
  batch: SyncBatch,
  ctx: { now: number; persist?: (next: DomainState) => void }
): { state: DomainState; result: BatchResult } {
  const now = ctx.now;

  if (state.ledger.some((e) => e.batchId === batch.batchId && e.outcome === "accepted")) {
    return { state, result: { outcome: "duplicate", conflictIds: [] } };
  }

  const error = validateBatch(state, batch);
  if (error) {
    const failed = structuredClone(state);
    failed.ledger.unshift({
      batchId: batch.batchId,
      terminal: batch.terminal,
      operator: batch.operator,
      shift: batch.shift,
      outcome: "failed",
      receivedAt: now,
      error,
      legacy: batch.legacy,
      opCount: batch.ops.length,
    });
    audit(failed, "batch", `批次 ${batch.batchId} 校验失败：${error}`, now);
    return { state: failed, result: { outcome: "failed", error, conflictIds: [] } };
  }

  const d = structuredClone(state);
  const conflictIds: string[] = [];
  for (const op of batch.ops) {
    if (op.kind === "record-write") {
      conflictIds.push(...applyRecordWrite(d, batch, op, now));
    } else {
      applyExceptionAction(d, batch, op, now);
    }
  }

  d.ledger.unshift({
    batchId: batch.batchId,
    terminal: batch.terminal,
    operator: batch.operator,
    shift: batch.shift,
    outcome: "accepted",
    receivedAt: now,
    legacy: batch.legacy,
    opCount: batch.ops.length,
  });
  audit(
    d,
    "batch",
    `${batch.legacy ? "[迁移] " : ""}批次 ${batch.batchId} 已接收（${batch.terminal}/${batch.operator}/${batch.shift}，${batch.ops.length} 条操作，阈值 ${batch.thresholdVersion}）`,
    now
  );

  try {
    ctx.persist?.(d);
  } catch (e) {
    // 写入失败：数据全部回滚，仅留 failed 台账，供单独重试
    const rolled = structuredClone(state);
    const message = e instanceof Error ? e.message : String(e);
    rolled.ledger.unshift({
      batchId: batch.batchId,
      terminal: batch.terminal,
      operator: batch.operator,
      shift: batch.shift,
      outcome: "failed",
      receivedAt: now,
      error: `写入失败：${message}`,
      legacy: batch.legacy,
      opCount: batch.ops.length,
    });
    audit(rolled, "batch", `批次 ${batch.batchId} 写入失败：${message}（可单独重试）`, now);
    return {
      state: rolled,
      result: { outcome: "failed", error: message, conflictIds: [] },
    };
  }

  return { state: d, result: { outcome: "accepted", conflictIds } };
}

function validateBatch(state: DomainState, b: SyncBatch): string | undefined {
  if (!b.batchId?.trim()) return "缺少批次号";
  if (!b.terminal?.trim() || !b.operator?.trim()) return "缺少终端或操作人";
  if (!b.shift) return "缺少班次";
  if (!b.thresholdVersion || !state.thresholds[b.thresholdVersion]) {
    return `未知阈值版本 ${b.thresholdVersion}（迁移旧数据必须先补阈值版本）`;
  }
  if (!Array.isArray(b.ops) || b.ops.length === 0) return "空批次";
  for (const op of b.ops) {
    if (!op.date || !op.shift || !op.roomId) return "操作缺少 日期/班次/房间";
    if (op.kind === "record-write") {
      if (op.roomClass && !ROOM_CLASSES.includes(op.roomClass)) return `未知洁净等级 ${op.roomClass}`;
      for (const key of Object.keys(op.fields) as FieldKey[]) {
        try {
          normalizeValue(key, op.fields[key] as string | number);
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      }
    } else if (!op.note?.trim()) {
      return "异常处置/备注必须填写内容";
    }
  }
  return undefined;
}

/** 字段级合并，返回本操作新增的待确认冲突 id */
function applyRecordWrite(
  d: DomainState,
  b: SyncBatch,
  op: RecordWriteOp,
  now: number
): string[] {
  if (op.kind !== "record-write") return [];
  const id = recordKey(op.date, op.shift, op.roomId);
  let rec = d.records[id];
  const source = makeSource(b, now);
  if (!rec) {
    rec = {
      id,
      roomId: op.roomId,
      date: op.date,
      shift: op.shift,
      revision: 0,
      fields: {},
      conflicts: [],
      judgments: [],
      createdAt: now,
      updatedAt: now,
    };
    d.records[id] = rec;
    audit(d, "merge", `${op.roomId} ${op.shift} 建记录（批次 ${b.batchId}）`, now);
  }

  if (op.roomClass && !rec.fields.roomClass) {
    rec.fields.roomClass = {
      value: op.roomClass,
      source,
      fieldRevision: 1,
      updatedAt: now,
    };
    rec.revision += 1;
  }

  const newConflictIds: string[] = [];
  for (const field of Object.keys(op.fields) as FieldKey[]) {
    const incoming = normalizeValue(field, op.fields[field] as string | number);
    const existing = rec.fields[field];
    const baseRev = op.baseFieldRevisions[field] ?? 0;

    if (!existing) {
      rec.fields[field] = { value: incoming, source, fieldRevision: 1, updatedAt: now };
      rec.revision += 1;
      audit(d, "merge", `${op.roomId} ${op.shift} 字段「${field}」由 ${b.terminal} 首填`, now);
      continue;
    }
    if (valueEquals(existing.value, incoming)) continue; // 同值，无需处理

    if (b.legacy) {
      // 旧浏览器补录：只补空缺，绝不覆盖新数据
      audit(
        d,
        "legacy",
        `[迁移] ${op.roomId} ${op.shift} 字段「${field}」已有新值，旧值保留为历史不覆盖`,
        now
      );
      continue;
    }

    if (baseRev >= existing.fieldRevision) {
      // 封包时已看过当前版本：正常后写覆盖（不同字段各自走到这里互不影响）
      rec.fields[field] = {
        value: incoming,
        source,
        fieldRevision: existing.fieldRevision + 1,
        updatedAt: now,
      };
      rec.revision += 1;
      audit(
        d,
        "merge",
        `${op.roomId} ${op.shift} 字段「${field}」基于 r${existing.fieldRevision} 更新到 r${existing.fieldRevision + 1}（批次 ${b.batchId}）`,
        now
      );
      // 基于最新版本的新写入到达，同字段旧冲突自动收敛
      const stale = rec.conflicts.find((c) => c.field === field && c.status === "pending");
      if (stale) autoResolveConflict(d, rec, stale, incoming, source, now);
    } else {
      // 两班基于同一旧版改了同一字段：停在待确认，两版都列出
      const cid = registerConflict(d, rec, field, existing, incoming, baseRev, source, now);
      if (cid) newConflictIds.push(cid);
    }
  }

  rec.updatedAt = now;

  // 仅当本次粒子计数被实际接受（未卡在冲突里）才联动异常
  const appliedCount = rec.fields.particleCount;
  if (
    typeof op.fields.particleCount !== "undefined" &&
    appliedCount &&
    appliedCount.source.batchId === b.batchId &&
    !rec.conflicts.some((c) => c.field === "particleCount" && c.status === "pending")
  ) {
    evaluateParticle(d, rec, Number(appliedCount.value), b, source, now);
  } else if (
    typeof op.fields.particleCount !== "undefined" &&
    rec.conflicts.some((c) => c.field === "particleCount" && c.status === "pending")
  ) {
    audit(
      d,
      "conflict",
      `${op.roomId} ${op.shift} 粒子计数两版冲突待确认，异常状态暂不联动`,
      now
    );
  }
  return newConflictIds;
}

function registerConflict(
  d: DomainState,
  rec: InspectionRecord,
  field: FieldKey,
  existing: FieldValue,
  incomingValue: string | number,
  baseRev: number,
  source: Source,
  now: number
): string | undefined {
  let conflict = rec.conflicts.find((c) => c.field === field && c.status === "pending");
  const incomingVersion = { value: incomingValue, source, baseFieldRevision: baseRev };
  if (conflict) {
    if (conflict.versions.some((v) => v.source.batchId === source.batchId)) return undefined;
    conflict.versions.push(incomingVersion);
    audit(
      d,
      "conflict",
      `${rec.roomId} ${rec.shift} 字段「${field}」冲突追加第 ${conflict.versions.length} 版（批次 ${source.batchId}）`,
      now
    );
    return conflict.id;
  }
  conflict = {
    id: nextId(d, "cfl"),
    field,
    status: "pending",
    versions: [
      {
        value: existing.value,
        source: existing.source,
        baseFieldRevision: existing.fieldRevision,
      },
      incomingVersion,
    ],
    createdAt: now,
  };
  rec.conflicts.push(conflict);
  audit(
    d,
    "conflict",
    `${rec.roomId} ${rec.shift} 字段「${field}」两班同改，停在待确认：r${existing.fieldRevision}=${existing.value} vs 批次 ${source.batchId}=${incomingValue}`,
    now
  );
  return conflict.id;
}

function autoResolveConflict(
  d: DomainState,
  rec: InspectionRecord,
  conflict: FieldConflict,
  value: string | number,
  source: Source,
  now: number
) {
  const chosen: ConflictVersion = { value, source, baseFieldRevision: 0 };
  conflict.status = "resolved";
  conflict.chosen = chosen;
  conflict.resolvedAt = now;
  conflict.resolvedBy = "system";
  conflict.resolutionNote = "基于最新版本的后续写入自动收敛";
  audit(d, "conflict", `${rec.roomId} ${rec.shift} 字段「${conflict.field}」冲突随新写入自动收敛`, now);
}

/** 人工在待确认列表中选择其中一版 */
export function resolveConflict(
  state: DomainState,
  recordId: string,
  conflictId: string,
  chosenBatchId: string,
  operator: string,
  now: number
): DomainState {
  const d = structuredClone(state);
  const rec = d.records[recordId];
  const conflict = rec?.conflicts.find((c) => c.id === conflictId);
  if (!rec || !conflict || conflict.status !== "pending") return state;
  const chosen = conflict.versions.find((v) => v.source.batchId === chosenBatchId);
  if (!chosen) return state;

  const current = rec.fields[conflict.field];
  rec.fields[conflict.field] = {
    value: chosen.value,
    source: chosen.source,
    fieldRevision: (current?.fieldRevision ?? 0) + 1,
    updatedAt: now,
  };
  rec.revision += 1;
  conflict.status = "resolved";
  conflict.chosen = chosen;
  conflict.resolvedAt = now;
  conflict.resolvedBy = operator;
  audit(
    d,
    "conflict",
    `${rec.roomId} ${rec.shift} 字段「${conflict.field}」经 ${operator} 确认采用批次 ${chosenBatchId} 的版本：${chosen.value}`,
    now
  );

  if (conflict.field === "particleCount" && !rec.conflicts.some((c) => c.field === "particleCount" && c.status === "pending")) {
    evaluateParticle(
      d,
      rec,
      Number(chosen.value),
      {
        batchId: chosen.source.batchId,
        thresholdVersion: chosen.source.thresholdVersion,
        legacy: chosen.source.legacy,
      },
      chosen.source,
      now
    );
  }
  return d;
}

// ---------- 粒子判定与异常状态机 ----------

function currentRoomClass(rec: InspectionRecord): RoomClass | undefined {
  const v = rec.fields.roomClass?.value;
  return ROOM_CLASSES.includes(v as RoomClass) ? (v as RoomClass) : undefined;
}

function evaluateParticle(
  d: DomainState,
  rec: InspectionRecord,
  count: number,
  batchRef: Pick<SyncBatch, "batchId" | "thresholdVersion" | "legacy">,
  source: Source,
  now: number
) {
  const roomClass = currentRoomClass(rec);
  const tv = d.thresholds[batchRef.thresholdVersion];
  if (!tv || !roomClass) {
    audit(d, "exception", `${rec.roomId} 缺少等级或阈值版本，粒子判定未联动`, now);
    return;
  }
  const limit = tv.limits[roomClass];
  if (typeof limit !== "number") return;
  const exceeded = count > limit;

  const judgment: ParticleJudgment = {
    id: nextId(d, "jud"),
    batchId: batchRef.batchId,
    thresholdVersion: batchRef.thresholdVersion,
    particleCount: count,
    limit,
    exceeded,
    at: source.at,
    source,
  };
  rec.judgments.push(judgment);

  const expId = exceptionKey(rec.id);
  let exp = d.exceptions[expId];

  if (batchRef.legacy) {
    // 迁移数据：判定只入历史时间线，绝不创建/驱动当前异常状态
    if (exp) {
      pushEvent(exp, {
        type: "recheck",
        note: `[历史迁移·阈值 ${batchRef.thresholdVersion}] 粒子计数 ${count}，上限 ${limit}，${exceeded ? "超限" : "合格"}（归档不改变当前状态）`,
        thresholdVersion: batchRef.thresholdVersion,
        particleCount: count,
        limit,
      }, source, now, d);
    }
    audit(
      d,
      "legacy",
      `[迁移] ${rec.roomId} 历史粒子判定 ${count}/${limit} 已归档可查，不改变当前异常状态`,
      now
    );
    return;
  }

  if (!exp) {
    if (!exceeded) return;
    exp = {
      id: expId,
      recordId: rec.id,
      roomId: rec.roomId,
      date: rec.date,
      shift: rec.shift,
      status: "open",
      events: [],
    };
    d.exceptions[expId] = exp;
    pushEvent(
      exp,
      {
        type: "opened",
        note: `粒子计数 ${count} 超过阈值 ${batchRef.thresholdVersion} 上限 ${limit}`,
        thresholdVersion: batchRef.thresholdVersion,
        particleCount: count,
        limit,
      },
      source,
      now,
      d
    );
    audit(d, "exception", `${rec.roomId} ${rec.shift} 粒子 ${count} > ${limit}，异常打开`, now);
    return;
  }

  if (exceeded && exp.status === "resolved") {
    // 关键守卫：旧批次不能把已处置改回待处理；只有「新」计数再次超限才重新打开
    const resolveEvent = exp.events.find((e) => e.type === "resolved");
    const resolvedAt = resolveEvent?.source.at ?? 0;
    // 现场封包时间早于/等于处置时间 → 旧批次补传，不得回退
    const isStale = source.at <= resolvedAt;
    if (isStale) {
      pushEvent(
        exp,
        {
          type: "recheck",
          note: `旧批次 ${source.batchId} 补传的粒子 ${count} 虽超上限 ${limit}，但封包于处置之前，已处置状态不回退（守卫拦截）`,
          thresholdVersion: batchRef.thresholdVersion,
          particleCount: count,
          limit,
        },
        source,
        now,
        d
      );
      audit(
        d,
        "exception",
        `${rec.roomId} 旧批次 ${source.batchId} 试图把已处置改回待处理，已拦截（处置保留）`,
        now
      );
    } else {
      exp.status = "open";
      pushEvent(
        exp,
        {
          type: "reopened",
          note: `新粒子计数 ${count} 再次超过阈值 ${batchRef.thresholdVersion} 上限 ${limit}，重新打开；原有处置保留在下方时间线`,
          thresholdVersion: batchRef.thresholdVersion,
          particleCount: count,
          limit,
        },
        source,
        now,
        d
      );
      audit(d, "exception", `${rec.roomId} ${rec.shift} 新计数 ${count} > ${limit}，异常重新打开（原处置保留）`, now);
    }
  } else if (exceeded) {
    pushEvent(
      exp,
      {
        type: "recheck",
        note: `复测粒子 ${count} 仍超上限 ${limit}`,
        thresholdVersion: batchRef.thresholdVersion,
        particleCount: count,
        limit,
      },
      source,
      now,
      d
    );
  } else {
    pushEvent(
      exp,
      {
        type: "recheck",
        note: `复测粒子 ${count}，上限 ${limit}，本次合格`,
        thresholdVersion: batchRef.thresholdVersion,
        particleCount: count,
        limit,
      },
      source,
      now,
      d
    );
  }

  // 新阈值下的新计数到达，自动接管挂起的重新确认
  if (exp.reconfirm && batchRef.thresholdVersion === d.currentThresholdVersion) {
    audit(
      d,
      "threshold",
      `${rec.roomId} 新版本下的新计数到达，撤销阈值升级挂起的人工重新确认`,
      now
    );
    exp.reconfirm = undefined;
    for (const j of rec.judgments) {
      if (j.reconfirm?.status === "pending" && j.thresholdVersion !== d.currentThresholdVersion) {
        j.reconfirm = undefined;
      }
    }
  }
}

function pushEvent(
  exp: ExceptionRecord,
  ev: Omit<ExceptionEvent, "id" | "at" | "batchId" | "operator" | "source">,
  source: Source,
  now: number,
  d: DomainState
) {
  // at 用现场时间：离线补传批次按发生时刻参与排序与旧批次守卫；receivedAt 保留回网顺序
  exp.events.push({
    id: nextId(d, "evt"),
    at: source.at,
    batchId: source.batchId,
    operator: source.operator,
    source,
    ...ev,
  });
  exp.events.sort((a, b) =>
    b.at - a.at || b.source.receivedAt - a.source.receivedAt
  );
}

function applyExceptionAction(
  d: DomainState,
  b: SyncBatch,
  op: SyncBatch["ops"][number],
  now: number
) {
  if (op.kind !== "exception-action") return;
  const recId = recordKey(op.date, op.shift, op.roomId);
  const expId = exceptionKey(recId);
  const exp = d.exceptions[expId];
  const source = makeSource(b, now);

  if (b.legacy) {
    // 历史处置导入：可查、不覆盖当前状态；仅由历史数据建立的异常直接归档，不进待处理列表
    const created = ensureHistoryException(d, op, expId);
    const wasExisting = !!exp;
    if (created.events.some((e) => e.batchId === b.batchId && e.type === (op.action === "resolve" ? "resolved" : "note"))) return;
    pushEvent(
      created,
      {
        type: op.action === "resolve" ? "resolved" : "note",
        note: `[历史迁移] ${op.note}`,
        thresholdVersion: op.thresholdVersion,
      },
      source,
      now,
      d
    );
    if (!wasExisting) {
      // 仅由历史数据建立的异常一律归档（视为历史事项），不进入当前待处理
      created.status = "resolved";
    }
    audit(d, "legacy", `[迁移] ${op.roomId} 历史处置已归档可查，不改变当前状态`, now);
    return;
  }

  if (!exp) {
    // 离线乱序：处置/备注可能早于超限判定回网 —— 先建单承接事件，
    // 状态保持 open（真实闭环仍需有超限记录或后续处置来收敛）
    const created: ExceptionRecord = {
      id: expId,
      recordId: recId,
      roomId: op.roomId,
      date: op.date,
      shift: op.shift,
      status: "open",
      events: [],
    };
    d.exceptions[expId] = created;
    if (op.action === "resolve") {
      created.status = "resolved";
      pushEvent(
        created,
        { type: "resolved", note: `${op.note}（处置早于超限记录回网，补建档）`, thresholdVersion: op.thresholdVersion },
        source,
        now,
        d
      );
    } else {
      pushEvent(created, { type: "note", note: op.note, thresholdVersion: op.thresholdVersion }, source, now, d);
    }
    audit(d, "exception", `${op.roomId} 处置/备注先于异常判定到达，已补建异常单`, now);
    return;
  }
  if (exp.events.some((e) => e.batchId === b.batchId && e.type === op.action)) return;

  if (op.action === "resolve") {
    if (exp.status === "open") {
      exp.status = "resolved";
      pushEvent(
        exp,
        { type: "resolved", note: op.note, thresholdVersion: op.thresholdVersion },
        source,
        now,
        d
      );
      audit(d, "exception", `${op.roomId} 异常已处置：${op.note}`, now);
    } else {
      pushEvent(
        exp,
        { type: "note", note: `重复封包的处置，状态维持已处置：${op.note}`, thresholdVersion: op.thresholdVersion },
        source,
        now,
        d
      );
    }
  } else {
    pushEvent(exp, { type: "note", note: op.note, thresholdVersion: op.thresholdVersion }, source, now, d);
    audit(d, "exception", `${op.roomId} 异常追加备注：${op.note}`, now);
  }
}

function ensureHistoryException(
  d: DomainState,
  op: { date: string; shift: SyncBatch["shift"]; roomId: string },
  expId: string
): ExceptionRecord {
  let exp = d.exceptions[expId];
  if (!exp) {
    exp = {
      id: expId,
      recordId: recordKey(op.date, op.shift, op.roomId),
      roomId: op.roomId,
      date: op.date,
      shift: op.shift,
      status: "open",
      events: [],
    };
    d.exceptions[expId] = exp;
  }
  return exp;
}

// ---------- 人工处置（在线终端） ----------

export function resolveException(
  state: DomainState,
  recordId: string,
  note: string,
  operator: string,
  thresholdVersion: string,
  now: number
): DomainState {
  const d = structuredClone(state);
  const exp = d.exceptions[exceptionKey(recordId)];
  if (!exp || !note.trim()) return state;
  const source: Source = {
    batchId: `online-${d.seq + 1}`,
    terminal: "在线看板",
    operator,
    shift: exp.shift,
    at: now,
    receivedAt: now,
    thresholdVersion,
  };
  if (exp.status === "open") {
    exp.status = "resolved";
    pushEvent(exp, { type: "resolved", note, thresholdVersion }, source, now, d);
    audit(d, "exception", `${exp.roomId} 异常已处置：${note}`, now);
  }
  return d;
}

// ---------- 阈值版本 ----------

export function upgradeThreshold(
  state: DomainState,
  next: ThresholdVersion,
  now: number
): DomainState {
  // 版本可能早已「已知」（用于校验旧批次），但未必「生效」；只有已生效才跳过
  if (state.currentThresholdVersion === next.version) return state;
  const d = structuredClone(state);
  const oldVersion = d.currentThresholdVersion;
  d.thresholds[next.version] = next;
  d.currentThresholdVersion = next.version;

  for (const rec of Object.values(d.records)) {
    for (const j of rec.judgments) {
      if (j.thresholdVersion !== next.version && !j.source.legacy) {
        j.reconfirm = { toVersion: next.version, status: "pending" };
      }
    }
    const latest = [...rec.judgments].reverse().find((j) => !j.source.legacy);
    if (!latest) continue;
    const roomClass = currentRoomClass(rec);
    const newLimit = roomClass ? next.limits[roomClass] : undefined;
    if (typeof newLimit !== "number") continue;

    // 旧合格判定在收紧的新阈值下可能变为超限：同样挂起，必要时补建异常单
    let exp = d.exceptions[exceptionKey(rec.id)];
    if (!exp && latest.particleCount > newLimit) {
      exp = {
        id: exceptionKey(rec.id),
        recordId: rec.id,
        roomId: rec.roomId,
        date: rec.date,
        shift: rec.shift,
        // 补建单保持已处置态，仅承载重新确认；确认仍超限由 reconfirm 重开
        status: "resolved",
        events: [
          {
            id: nextId(d, "evt"),
            at: latest.at,
            batchId: latest.batchId,
            operator: latest.source.operator,
            source: latest.source,
            type: "recheck",
            note: `旧阈值 ${latest.thresholdVersion} 下判定合格（${latest.particleCount} ≤ 当时上限 ${latest.limit}）`,
            thresholdVersion: latest.thresholdVersion,
            particleCount: latest.particleCount,
            limit: latest.limit,
          },
        ],
      };
      d.exceptions[exceptionKey(rec.id)] = exp;
    }
    if (!exp) continue;

    const proposed = latest.particleCount > newLimit ? ("exceeded" as const) : ("ok" as const);
    exp.reconfirm = {
      fromVersion: latest.thresholdVersion,
      toVersion: next.version,
      proposed,
      proposedCount: latest.particleCount,
      at: now,
    };
    audit(
      d,
      "threshold",
      `阈值 ${oldVersion} → ${next.version}：${exp.roomId} ${rec.shift} 旧判定挂起重新确认（最近计数 ${latest.particleCount}，新上限 ${newLimit}，建议「${proposed === "exceeded" ? "仍超限" : "合格"}」）`,
      now
    );
  }
  audit(d, "threshold", `阈值版本升级 ${oldVersion} → ${next.version}：${next.note}`, now);
  return d;
}

export function reconfirmException(
  state: DomainState,
  recordId: string,
  confirmedExceeded: boolean,
  operator: string,
  now: number
): DomainState {
  const d = structuredClone(state);
  const exp = d.exceptions[exceptionKey(recordId)];
  const rec = d.records[recordId];
  if (!exp || !rec || !exp.reconfirm) return state;
  const { toVersion, proposedCount } = exp.reconfirm;
  const roomClass = currentRoomClass(rec);
  const limit = roomClass ? d.thresholds[toVersion]?.limits[roomClass] : undefined;

  for (const j of rec.judgments) {
    if (j.reconfirm?.status === "pending") {
      j.reconfirm = {
        toVersion,
        status: confirmedExceeded ? "confirmed-exceeded" : "confirmed-ok",
        at: now,
        operator,
      };
    }
  }
  exp.reconfirm = undefined;
  const source: Source = {
    batchId: `reconfirm-${d.seq + 1}`,
    terminal: "在线看板",
    operator,
    shift: exp.shift,
    at: now,
    receivedAt: now,
    thresholdVersion: toVersion,
  };

  if (confirmedExceeded) {
    if (exp.status === "resolved") {
      exp.status = "open";
      pushEvent(
        exp,
        {
          type: "reopened",
          note: `阈值 ${toVersion} 重新确认仍超限（${proposedCount}${typeof limit === "number" ? ` > ${limit}` : ""}），重新打开；原处置保留`,
          thresholdVersion: toVersion,
          particleCount: proposedCount,
          limit,
        },
        source,
        now,
        d
      );
      audit(d, "threshold", `${exp.roomId} 新阈值下复核仍超限，重新打开（原处置保留）`, now);
    } else {
      pushEvent(
        exp,
        { type: "recheck", note: `阈值 ${toVersion} 重新确认仍超限`, thresholdVersion: toVersion, particleCount: proposedCount, limit },
        source,
        now,
        d
      );
    }
  } else {
    pushEvent(
      exp,
      { type: "recheck", note: `阈值 ${toVersion} 复核合格（${proposedCount}${typeof limit === "number" ? ` ≤ ${limit}` : ""}）`, thresholdVersion: toVersion, particleCount: proposedCount, limit },
      source,
      now,
      d
    );
    audit(d, "threshold", `${exp.roomId} 新阈值下复核合格`, now);
  }
  return d;
}
