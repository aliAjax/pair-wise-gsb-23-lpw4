import { ConflictVersion, FieldConflict, FIELD_LABELS, InspectionRecord } from "../domain/types";

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function VersionCard({
  v,
  onChoose,
  chosen,
}: {
  v: ConflictVersion;
  onChoose: () => void;
  chosen: boolean;
}) {
  return (
    <div className={`version-card ${chosen ? "chosen" : ""}`}>
      <div className="version-value">{String(v.value)}</div>
      <div className="version-meta">
        <span className={`src-tag ${v.source.legacy ? "legacy" : ""}`}>
          {v.source.legacy ? "迁移" : v.source.terminal}
        </span>
        {v.source.operator} · {v.source.shift}
      </div>
      <div className="version-meta">
        批次 {v.source.batchId} · 基于 r{v.baseFieldRevision} · 阈值 {v.source.thresholdVersion}
      </div>
      <div className="version-meta">现场 {fmtTime(v.source.at)}</div>
      {!chosen && (
        <button className="mini primary" onClick={onChoose}>
          采用此版
        </button>
      )}
      {chosen && <span className="chosen-badge">已采用</span>}
    </div>
  );
}

export function ConflictPanel({
  items,
  onChoose,
}: {
  items: { record: InspectionRecord; conflict: FieldConflict }[];
  onChoose: (recordId: string, conflictId: string, batchId: string) => void;
}) {
  return (
    <section className="panel conflict-panel">
      <div className="section-heading">
        <div>
          <p>同一字段两班都改过</p>
          <h2>待确认冲突 {items.length > 0 && <em className="badge danger">{items.length}</em>}</h2>
        </div>
      </div>
      {items.length === 0 && <p className="empty">没有待确认冲突。不同字段已按来源自动合并。</p>}
      <div className="conflict-list">
        {items.map(({ record, conflict }) => (
          <article key={conflict.id} className="conflict-card">
            <header>
              <strong>
                {record.roomId} · {record.shift}
              </strong>
              <span className="field-tag">{FIELD_LABELS[conflict.field]}</span>
              <span className="muted">
                两版基于同一旧版 r{conflict.versions[0]?.baseFieldRevision}，停在待确认
              </span>
            </header>
            <div className="versions">
              {conflict.versions.map((v) => (
                <VersionCard
                  key={v.source.batchId}
                  v={v}
                  chosen={false}
                  onChoose={() => onChoose(record.id, conflict.id, v.source.batchId)}
                />
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
