// 供看板使用的只读派生视图
import {
  DomainState,
  ExceptionRecord,
  FieldConflict,
  FieldKey,
  InspectionRecord,
  exceptionKey,
} from "./types";

export function getRecord(state: DomainState, id: string): InspectionRecord | undefined {
  return state.records[id];
}

export function listRecords(state: DomainState): InspectionRecord[] {
  return Object.values(state.records).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function exceptionFor(state: DomainState, recordId: string): ExceptionRecord | undefined {
  return state.exceptions[exceptionKey(recordId)];
}

export function listExceptions(state: DomainState): ExceptionRecord[] {
  return Object.values(state.exceptions).sort((a, b) => {
    const latest = (e: ExceptionRecord) =>
      e.events.reduce((m, ev) => Math.max(m, ev.source.receivedAt), 0);
    return latest(b) - latest(a);
  });
}

export function pendingConflicts(state: DomainState): Array<{
  record: InspectionRecord;
  conflict: FieldConflict;
}> {
  const out: Array<{ record: InspectionRecord; conflict: FieldConflict }> = [];
  for (const rec of Object.values(state.records)) {
    for (const conflict of rec.conflicts) {
      if (conflict.status === "pending") out.push({ record: rec, conflict });
    }
  }
  return out;
}

export function pendingReconfirms(state: DomainState): ExceptionRecord[] {
  return Object.values(state.exceptions).filter((e) => e.reconfirm);
}

export function openExceptionCount(state: DomainState): number {
  return Object.values(state.exceptions).filter((e) => e.status === "open").length;
}

export function fieldProvenance(
  rec: InspectionRecord,
  field: FieldKey
): string {
  const fv = rec.fields[field];
  if (!fv) return "未填";
  const tag = fv.source.legacy ? "[迁移]" : "";
  return `${tag}${fv.source.terminal} · ${fv.source.operator} · ${fv.source.shift} · r${fv.fieldRevision} · 阈值${fv.source.thresholdVersion}`;
}

export interface BoardMetrics {
  rooms: number;
  conflicts: number;
  openExceptions: number;
  reconfirm: number;
  failedBatches: number;
}

export function metrics(state: DomainState): BoardMetrics {
  return {
    rooms: Object.keys(state.records).length,
    conflicts: pendingConflicts(state).length,
    openExceptions: openExceptionCount(state),
    reconfirm: pendingReconfirms(state).length,
    failedBatches: state.ledger.filter((e) => e.outcome === "failed").length,
  };
}
