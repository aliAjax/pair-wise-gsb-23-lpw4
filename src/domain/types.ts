// 洁净室巡检 —— 领域模型类型定义

export type Shift = "夜班" | "早班" | "中班";

export type RoomClass = "ISO 5" | "ISO 6" | "ISO 7" | "黄光区";

/** 字段级来源：每个字段值都知道自己来自哪一批、哪个离线终端、谁写的 */
export interface Source {
  batchId: string;
  terminal: string;
  operator: string;
  shift: Shift;
  /** 现场记录/封包时间（离线终端上的时间，用于旧批次守卫） */
  at: number;
  /** 回网接收时间 */
  receivedAt: number;
  /** 本来源写入时所依据的阈值版本 */
  thresholdVersion: string;
  /** 旧浏览器补录数据迁移而来 */
  legacy?: boolean;
}

/** 巡检记录可写字段（粒子计数、处理备注等不同字段各自保留来源） */
export type FieldKey =
  | "roomClass"
  | "particleCount"
  | "temperature"
  | "humidity"
  | "pressureDiff"
  | "equipmentStatus"
  | "handlingNote";

export const FIELD_LABELS: Record<FieldKey, string> = {
  roomClass: "洁净等级",
  particleCount: "粒子计数(个/m³·0.5μm)",
  temperature: "温度(℃)",
  humidity: "湿度(%RH)",
  pressureDiff: "压差(Pa)",
  equipmentStatus: "设备状态",
  handlingNote: "处理备注",
};

export interface FieldValue {
  value: string | number;
  source: Source;
  /** 该字段自身的写入序号，离线终端据此判断两批是否并发改了同一字段 */
  fieldRevision: number;
  updatedAt: number;
}

export interface ConflictVersion {
  value: string | number;
  source: Source;
  /** 该批封包时看到的字段序号 */
  baseFieldRevision: number;
}

export interface FieldConflict {
  id: string;
  field: FieldKey;
  status: "pending" | "resolved";
  /** 两班（可能多于两批）各自的版本，全部列出保留 */
  versions: ConflictVersion[];
  chosen?: ConflictVersion;
  createdAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
  resolutionNote?: string;
}

/** 一次粒子计数阈值判定（携带阈值版本，版本升级后要重新确认） */
export interface ParticleJudgment {
  id: string;
  batchId: string;
  thresholdVersion: string;
  particleCount: number;
  limit: number;
  exceeded: boolean;
  at: number;
  source: Source;
  reconfirm?: {
    toVersion: string;
    status: "pending" | "confirmed-exceeded" | "confirmed-ok";
    at?: number;
    operator?: string;
  };
}

export interface InspectionRecord {
  id: string;
  roomId: string;
  /** 班次日期 YYYY-MM-DD */
  date: string;
  shift: Shift;
  /** 整条记录的写序号 */
  revision: number;
  fields: Partial<Record<FieldKey, FieldValue>>;
  conflicts: FieldConflict[];
  judgments: ParticleJudgment[];
  createdAt: number;
  updatedAt: number;
}

export type ExceptionStatus = "open" | "resolved";

export type ExceptionEventType =
  | "opened"
  | "recheck"
  | "resolved"
  | "reopened"
  | "note";

export interface ExceptionEvent {
  id: string;
  type: ExceptionEventType;
  at: number;
  batchId: string;
  operator: string;
  thresholdVersion: string;
  particleCount?: number;
  limit?: number;
  note?: string;
  source: Source;
}

export interface ExceptionRecord {
  id: string;
  recordId: string;
  roomId: string;
  date: string;
  shift: Shift;
  status: ExceptionStatus;
  events: ExceptionEvent[];
  /** 阈值版本升级后，旧判定挂起等待重新确认 */
  reconfirm?: {
    fromVersion: string;
    toVersion: string;
    /** 按最新计数与新阈值给出的建议，最终由人确认 */
    proposed: "exceeded" | "ok";
    proposedCount: number;
    at: number;
  };
}

export interface ThresholdVersion {
  version: string;
  effectiveAt: number;
  note: string;
  /** 各洁净等级 0.5μm 粒子上限（个/m³） */
  limits: Partial<Record<RoomClass, number>>;
}

export interface RecordWriteOp {
  kind: "record-write";
  date: string;
  shift: Shift;
  roomId: string;
  roomClass?: RoomClass;
  /** 仅显式改过的字段才会出现 —— 字段级合并的依据 */
  fields: Partial<Record<FieldKey, string | number>>;
  /** 封包时整条记录的序号 */
  baseRevision: number;
  /** 封包时各字段的序号 */
  baseFieldRevisions: Partial<Record<FieldKey, number>>;
}

export interface ExceptionActionOp {
  kind: "exception-action";
  date: string;
  shift: Shift;
  roomId: string;
  action: "resolve" | "note";
  note: string;
  thresholdVersion: string;
}

export type SyncOp = RecordWriteOp | ExceptionActionOp;

export interface SyncBatch {
  batchId: string;
  terminal: string;
  operator: string;
  shift: Shift;
  /** 该批数据判定所依据的阈值版本 */
  thresholdVersion: string;
  /** 离线终端封包时间 */
  preparedAt: number;
  ops: SyncOp[];
  /** 旧浏览器补录迁移批次：只补空缺、只做历史登记，不触发重开 */
  legacy?: boolean;
}

export type BatchOutcome = "accepted" | "duplicate" | "failed";

export interface LedgerEntry {
  batchId: string;
  terminal: string;
  operator: string;
  shift: Shift;
  outcome: BatchOutcome;
  receivedAt: number;
  error?: string;
  legacy?: boolean;
  opCount: number;
}

export interface AuditEvent {
  id: string;
  at: number;
  message: string;
  kind: "merge" | "conflict" | "exception" | "threshold" | "batch" | "legacy";
}

export interface DomainState {
  records: Record<string, InspectionRecord>;
  exceptions: Record<string, ExceptionRecord>;
  thresholds: Record<string, ThresholdVersion>;
  currentThresholdVersion: string;
  ledger: LedgerEntry[];
  audit: AuditEvent[];
  seq: number;
}

export function recordKey(date: string, shift: Shift, roomId: string): string {
  return `${date}#${shift}#${roomId}`;
}

export function exceptionKey(recordId: string): string {
  return `exp#${recordId}`;
}
