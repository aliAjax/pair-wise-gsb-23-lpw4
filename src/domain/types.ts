// 洁净室巡检合并引擎领域类型

/** 班次（交接的两班 + 可选第三班） */
export type Shift = "早班" | "晚班" | "夜班";

/** 班组：数据来源（哪一班补录的数据，与“记录归属班次”相区分） */
export type Team = Shift;

/** 可以执行操作的人：来源班组或交接角色 */
export type Role = "巡检员" | "厂务工程师" | "班组长";
export type Actor = Team | Role;

/** 巡检记录可合并字段 */
export type FieldKey =
  | "isoClass"
  | "particleCount"
  | "temperature"
  | "humidity"
  | "pressureDiff"
  | "equipmentStatus"
  | "handlingNote";

export const FIELD_LABELS: Record<FieldKey, string> = {
  isoClass: "洁净等级",
  particleCount: "粒子计数(个/m³)",
  temperature: "温度(℃)",
  humidity: "湿度(%RH)",
  pressureDiff: "压差(Pa)",
  equipmentStatus: "设备状态",
  handlingNote: "处理备注",
};

/** 字段级来源信息：值 + 哪一班、哪个批次、何时、哪个阈值版本写入 */
export interface FieldVersion {
  value: string;
  team: Team;
  batchId: string;
  editedAt: number;
  thresholdVersion: number;
  legacy?: boolean;
}
/**
 * 字段合并状态。
 * - accepted：当前生效的一版（可能记录了多个不同字段各自的来源）
 * - candidates：同字段两班（或多班）都改过且取值不一致时，列出各版
 */
export interface FieldState {
  accepted: FieldVersion | null;
  /** 冲突中各班组的版本；为空或长度<2 表示无冲突 */
  candidates: FieldVersion[];
}

/** 合并主键：同一房间 + 同一巡检日期 + 同一班次 = 一条记录 */
export interface MergeKey {
  roomId: string;
  date: string;
  shift: Shift;
}

/** 异常处理事件（只追加，永不覆盖，重开时原有处置保留于此） */
export interface AnomalyEvent {
  type: "open" | "resolve" | "reopen" | "ignored-stale" | "reconfirm";
  at: number;
  /** 操作人：来源班组或交接角色（班组长/厂务工程师等） */
  team: Actor;
  batchId?: string;
  detail: string;
  /** resolve 事件携带的处置备注 */
  disposition?: string;
  thresholdVersion: number;
}

export type AnomalyStatus = "open" | "resolved" | "reopened";

/** 异常单：巡检记录与异常处理在此接起来 */
export interface Anomaly {
  id: string;
  recordKey: string;
  roomId: string;
  status: AnomalyStatus;
  /** 判定该异常所用阈值版本 */
  judgedThresholdVersion: number;
  /** 阈值版本升级后，旧判定需重新确认 */
  needsReconfirm: boolean;
  events: AnomalyEvent[];
  createdAt: number;
  updatedAt: number;
}

/** 巡检记录（一房间一班次一条） */
export interface InspectionRecord extends MergeKey {
  id: string;
  /** 记录级洁净等级（任一来源首填后，粒子判定统一使用） */
  isoClass: string | null;
  fields: Record<FieldKey, FieldState>;
  revision: number;
  /** 最近一次影响粒子判定的阈值版本；升级后旧判定需重新确认 */
  judgedThresholdVersion: number | null;
  needsReconfirm: boolean;
  /** 旧浏览器迁移来的记录 */
  legacy: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 阈值版本：各 ISO 等级 ≥0.5um 粒子上限（个/m³） */
export interface ThresholdVersion {
  version: number;
  label: string;
  activatedAt: number;
  limits: Record<string, number>;
}

/** 单条离线写入项 */
export interface BatchItem {
  roomId: string;
  shift: Shift;
  date: string;
  team: Team;
  editedAt: number;
  thresholdVersion: number;
  isoClass?: string;
  fields?: Partial<Record<FieldKey, string>>;
  /** 班组对异常的处置动作 */
  resolution?: { disposition: string };
  /** 旧浏览器导出的无班次/无阈值版本数据 */
  legacy?: boolean;
}

/** 离线批次 */
export interface Batch {
  id: string;
  label: string;
  team: Team;
  createdAt: number;
  items: BatchItem[];
}

export type BatchOutcome =
  | "accepted"
  | "duplicate"
  | "failed"
  | "replayed";

export interface BatchLedgerEntry {
  batchId: string;
  label: string;
  team: Team;
  outcome: BatchOutcome;
  at: number;
  error?: string;
  touchedRecordKeys?: string[];
}

/** 完整服务端/合并中心状态 */
export interface MergeState {
  records: Record<string, InspectionRecord>;
  anomalies: Record<string, Anomaly>;
  /** recordKey -> anomalyId */
  anomalyIndex: Record<string, string>;
  thresholds: Record<number, ThresholdVersion>;
  currentThresholdVersion: number;
  ledger: BatchLedgerEntry[];
  acceptedBatchIds: string[];
  failedBatches: Record<string, { batch: Batch; error: string }>;
}

export interface BatchItemReport {
  recordKey: string;
  isNewRecord: boolean;
  mergedFields: FieldKey[];
  conflictFields: FieldKey[];
  anomaly?: {
    id?: string;
    action:
      | "opened"
      | "reopened"
      | "already-open"
      | "stale-ignored"
      | "resolved"
      | "resolve-stale-ignored"
      | "normal"
      | "none";
    detail: string;
  };
}

export interface BatchResult {
  outcome: BatchOutcome;
  state: MergeState;
  reports: BatchItemReport[];
  error?: string;
}

export interface ConflictChoice {
  recordKey: string;
  field: FieldKey;
  /** 选择采用哪一班的版本；或手动给出终版 */
  chooseTeam?: Team;
  manualValue?: string;
  /** 裁决人：班组长/厂务工程师或某班组 */
  decidedBy: Actor;
  decidedAt: number;
}

/** 旧浏览器迁移输入（无班次/无阈值版本，迁移时补录） */
export interface LegacyInput {
  roomId: string;
  capturedAt: number;
  shift: Shift;
  thresholdVersion: number;
  date: string;
  fields?: Partial<Record<FieldKey, string>>;
  pastDisposition?: { note: string; disposedAt: number };
}
