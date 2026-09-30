import { LedgerEntry } from "../domain/types";
import { SyncBatch } from "../domain/types";

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

const OUTCOME_LABEL: Record<LedgerEntry["outcome"], string> = {
  accepted: "已接收",
  duplicate: "重复忽略",
  failed: "写入失败",
};

export function LedgerPanel({
  ledger,
  outbox,
  onRetry,
  onDismiss,
}: {
  ledger: LedgerEntry[];
  outbox: SyncBatch[];
  onRetry: (batchId: string) => void;
  onDismiss: (batchId: string) => void;
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>回网批次台账</p>
          <h2>
            接收记录{" "}
            {outbox.length > 0 && <em className="badge danger">{outbox.length} 批待重试</em>}
          </h2>
        </div>
      </div>

      {outbox.length > 0 && (
        <div className="outbox">
          {outbox.map((b) => (
            <div key={b.batchId} className="outbox-row">
              <div>
                <strong>{b.batchId}</strong>
                <span className="muted">
                  {" "}
                  {b.terminal} · {b.operator} · {b.ops.length} 条操作 · 封包{" "}
                  {fmtTime(b.preparedAt)}
                </span>
                <div className="error-text">该批写入失败，数据未落库（可单独重试，不影响其他批次）</div>
              </div>
              <div className="row-actions">
                <button className="mini primary" onClick={() => onRetry(b.batchId)}>
                  单独重试
                </button>
                <button className="mini" onClick={() => onDismiss(b.batchId)}>
                  移除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <table className="ledger-table">
        <thead>
          <tr>
            <th>批次</th>
            <th>来源</th>
            <th>结果</th>
            <th>回网时间</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {ledger.map((e, i) => (
            <tr key={`${e.batchId}-${i}`} className={`row-${e.outcome}`}>
              <td>
                {e.batchId}
                {e.legacy && <span className="src-tag legacy">迁移</span>}
              </td>
              <td>
                {e.terminal} · {e.operator} · {e.shift}
              </td>
              <td>
                <span className={`pill pill-${e.outcome === "accepted" ? "ok" : e.outcome === "duplicate" ? "idle" : "danger"}`}>
                  {OUTCOME_LABEL[e.outcome]}
                </span>
              </td>
              <td>{fmtTime(e.receivedAt)}</td>
              <td className="muted">{e.error ?? `${e.opCount} 条操作`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
