import { FIELD_LABELS, FieldKey, InspectionRecord } from "../domain/types";
import { exceptionFor } from "../domain/selectors";
import { DomainState } from "../domain/types";

const FIELD_ORDER: FieldKey[] = [
  "roomClass",
  "particleCount",
  "temperature",
  "humidity",
  "pressureDiff",
  "equipmentStatus",
  "handlingNote",
];

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

export function RecordCard({
  state,
  record,
}: {
  state: DomainState;
  record: InspectionRecord;
}) {
  const exp = exceptionFor(state, record.id);
  const pendingFields = new Set(
    record.conflicts.filter((c) => c.status === "pending").map((c) => c.field)
  );

  return (
    <article className="record-card-v2">
      <header>
        <div>
          <strong>{record.roomId}</strong>
          <span className="muted">
            {" "}
            {record.date} · {record.shift} · 整条 r{record.revision}
          </span>
        </div>
        <div>
          {exp && (
            <span className={`pill ${exp.status === "open" ? "pill-danger" : "pill-ok"}`}>
              异常{exp.status === "open" ? "待处理" : "已处置"}
            </span>
          )}
          {pendingFields.size > 0 && (
            <span className="pill pill-warn">{pendingFields.size} 字段待确认</span>
          )}
        </div>
      </header>

      <div className="field-table">
        {FIELD_ORDER.map((key) => {
          const fv = record.fields[key];
          if (!fv) return null;
          const inConflict = pendingFields.has(key);
          return (
            <div key={key} className={`field-row ${inConflict ? "row-conflict" : ""}`}>
              <div className="field-name">{FIELD_LABELS[key]}</div>
              <div className="field-value">
                {String(fv.value)}
                {inConflict && <span className="conflict-flag">待确认</span>}
              </div>
              <div className="field-source">
                <span className={`src-tag ${fv.source.legacy ? "legacy" : ""}`}>
                  {fv.source.legacy ? "迁移" : fv.source.terminal}
                </span>
                {fv.source.operator} · r{fv.fieldRevision} · 阈值{fv.source.thresholdVersion}
                <div className="muted small">{fmtTime(fv.source.at)}</div>
              </div>
            </div>
          );
        })}
      </div>

      <details className="judgments">
        <summary>粒子判定历史（{record.judgments.length}）</summary>
        <ul>
          {record.judgments.map((j) => (
            <li key={j.id} className={j.exceeded ? "jud-bad" : "jud-ok"}>
              {j.particleCount} / 上限 {j.limit}（阈值 {j.thresholdVersion}）
              {j.exceeded ? " · 超限" : " · 合格"}
              {j.reconfirm?.status === "pending" && <strong className="warn"> · 旧判定待重新确认</strong>}
              {j.reconfirm?.status === "confirmed-exceeded" && " · 复核仍超限"}
              {j.reconfirm?.status === "confirmed-ok" && " · 复核合格"}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}
