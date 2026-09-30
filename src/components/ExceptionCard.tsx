import { useState } from "react";
import { ExceptionRecord } from "../domain/types";

const EVENT_LABEL: Record<string, string> = {
  opened: "异常打开",
  recheck: "复测记录",
  resolved: "处置",
  reopened: "重新打开",
  note: "备注",
};

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

export function ExceptionCard({
  exp,
  onResolve,
  onReconfirm,
}: {
  exp: ExceptionRecord;
  onResolve: (recordId: string, note: string) => void;
  onReconfirm: (recordId: string, exceeded: boolean) => void;
}) {
  const [note, setNote] = useState("");
  const recordId = exp.recordId;

  return (
    <article className={`exception-card status-${exp.status}`}>
      <header>
        <div>
          <strong>
            {exp.roomId} · {exp.shift}
          </strong>
          <span className={`pill ${exp.status === "open" ? "pill-danger" : "pill-ok"}`}>
            {exp.status === "open" ? "待处理" : "已处置"}
          </span>
          {exp.reconfirm && <span className="pill pill-warn">阈值升级·待重新确认</span>}
        </div>
        <span className="muted">事件 {exp.events.length} 条</span>
      </header>

      {exp.reconfirm && (
        <div className="reconfirm-box">
          <p>
            阈值由 {exp.reconfirm.fromVersion} 升级到 {exp.reconfirm.toVersion}，最近计数{" "}
            <strong>{exp.reconfirm.proposedCount}</strong>，按新阈值建议「
            {exp.reconfirm.proposed === "exceeded" ? "仍超限，需重开" : "合格"}」。旧判定需人工重新确认：
          </p>
          <div className="row-actions">
            <button className="mini danger" onClick={() => onReconfirm(recordId, true)}>
              确认仍超限（重开，原处置保留）
            </button>
            <button className="mini" onClick={() => onReconfirm(recordId, false)}>
              确认合格
            </button>
          </div>
        </div>
      )}

      <ol className="timeline">
        {exp.events.map((e) => (
          <li key={e.id} className={`tl-item tl-${e.type}`}>
            <div className="tl-head">
              <span className={`tl-type type-${e.type}`}>{EVENT_LABEL[e.type]}</span>
              <span className="muted">{fmtTime(e.at)}</span>
              <span className={`src-tag ${e.source.legacy ? "legacy" : ""}`}>
                {e.source.legacy ? "迁移" : e.source.terminal} · {e.operator}
              </span>
              <span className="muted">阈值 {e.thresholdVersion}</span>
            </div>
            <p>{e.note}</p>
            {typeof e.particleCount === "number" && (
              <p className="muted">
                粒子 {e.particleCount} 个/m³
                {typeof e.limit === "number" ? ` · 上限 ${e.limit}` : ""}
              </p>
            )}
          </li>
        ))}
      </ol>

      {exp.status === "open" && !exp.reconfirm && (
        <div className="resolve-box">
          <input
            placeholder="填写处置措施（原有处置会保留在时间线，新计数超限时异常可被重开）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button className="primary" disabled={!note.trim()} onClick={() => { onResolve(recordId, note.trim()); setNote(""); }}>
            标记已处置
          </button>
        </div>
      )}
    </article>
  );
}
