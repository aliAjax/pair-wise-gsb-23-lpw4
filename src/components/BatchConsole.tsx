import { useState } from "react";
import {
  DEMO_BATCHES,
  DUPLICATE_BATCH,
  FAILED_BATCH,
} from "../domain/demo";
import type { Batch, MergeState } from "../domain/types";
import { OUTCOME_META, Panel, fmtTime } from "./ui";

interface Props {
  state: MergeState;
  ingest: (batch: Batch, opts?: { simulateError?: string }) => void;
  retryFailed: (batchId: string) => void;
}

export function BatchConsole({ state, ingest, retryFailed }: Props) {
  const [nextIndex, setNextIndex] = useState(0);
  const failedList = Object.values(state.failedBatches);
  const nextBatch = DEMO_BATCHES[nextIndex] ?? null;

  return (
    <Panel
      title="离线批次回网"
      hint="合并队列"
      extra={
        <span className="queue-count">
          队列 {DEMO_BATCHES.length - nextIndex}/{DEMO_BATCHES.length}
        </span>
      }
    >
      <div className="batch-actions">
        <button
          className="primary-action"
          disabled={!nextBatch}
          onClick={() => {
            if (nextBatch) {
              ingest(nextBatch);
              setNextIndex((i) => i + 1);
            }
          }}
        >
          {nextBatch ? `接入下一批（${fmtTime(nextBatch.createdAt)}）` : "演示批次已全部接入"}
        </button>
        <button onClick={() => ingest(FAILED_BATCH, { simulateError: "回网超时（网关504）" })}>
          再模拟一批写入失败
        </button>
        <button onClick={() => ingest(DUPLICATE_BATCH)}>重放已接收批次（验去重）</button>
      </div>

      {nextBatch ? (
        <div className="next-batch">
          <strong>下一批：</strong>
          {nextBatch.label}
          <ul>
            {nextBatch.items.map((it, i) => (
              <li key={i}>
                {it.roomId} · {it.shift} · 来源{it.team} · 编辑于 {fmtTime(it.editedAt)} ·
                阈值v{it.thresholdVersion}
                {it.fields ? ` · ${Object.keys(it.fields).join("、")}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="muted-text">全部演示批次已接入，可继续模拟失败/重放或升级阈值。</p>
      )}

      {failedList.length > 0 && (
        <div className="failed-box">
          <h3>失败队列（{failedList.length}）— 整批未落库，可单独重试</h3>
          {failedList.map(({ batch, error }) => (
            <div key={batch.id} className="failed-row">
              <div>
                <strong>{batch.label}</strong>
                <span className="error-text">{error}</span>
              </div>
              <button
                className="primary-action"
                onClick={() => retryFailed(batch.id)}
              >
                单独重试该批
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="ledger">
        <h3>接收台账（已接收批次不可重复带入）</h3>
        {state.ledger.length === 0 ? (
          <p className="muted-text">暂无批次</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>批次</th>
                <th>来源</th>
                <th>结果</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {[...state.ledger].reverse().map((row, i) => {
                const meta = OUTCOME_META[row.outcome];
                return (
                  <tr key={`${row.batchId}-${i}`}>
                    <td>{row.label}</td>
                    <td>{row.team}</td>
                    <td>
                      <span className={`out-pill ${meta.cls}`}>{meta.label}</span>
                    </td>
                    <td className="muted-text">{row.error ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}
