import { useMemo } from "react";
import "./styles.css";
import { BatchConsole } from "./components/BatchConsole";
import { MigrationPanel } from "./components/MigrationPanel";
import { RecordCard } from "./components/RecordCard";
import { ThresholdBar } from "./components/ThresholdBar";
import { Panel } from "./components/ui";
import { useMergeStore, type ActionLog } from "./state/store";
import { DEMO_DATE } from "./domain/demo";

function App() {
  const store = useMergeStore();
  const { state } = store;

  const records = useMemo(
    () => Object.values(state.records).sort((a, b) => b.updatedAt - a.updatedAt),
    [state.records]
  );

  const stats = useMemo(() => {
    const anomalies = Object.values(state.anomalies);
    const open = anomalies.filter((a) => a.status === "open").length;
    const reopened = anomalies.filter((a) => a.status === "reopened").length;
    const conflicts = records.reduce(
      (n, r) =>
        n +
        (Object.values(r.fields) as { candidates: unknown[] }[]).filter(
          (f) => f.candidates.length >= 2
        ).length,
      0
    );
    const reconfirms = records.filter((r) => r.needsReconfirm).length;
    return { open, reopened, conflicts, reconfirms, failed: Object.keys(state.failedBatches).length };
  }, [state.anomalies, state.records, state.failedBatches, records]);

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-09 · 离线巡检合并中心 · 演示日期 {DEMO_DATE}</p>
          <h1>半导体洁净室巡检 · 两班交接合并</h1>
          <p className="subtitle">
            同一房间同一班次只保留一条巡检记录：不同字段各自保留来源班组；同一字段两班都改过则
            <b>停在待确认</b>并列出两版。巡检记录与异常处理接线：已处置异常不被旧批次改回待处理，
            新计数再次超限自动重开并保留原处置；阈值版本升级后旧判定重新确认；批次失败可单独重试、
            已接收批次幂等去重；旧浏览器数据补上班次与阈值版本后历史处置仍可查。
          </p>
        </div>
        <div className="stack-card">
          <span>当前阈值版本</span>
          <strong>{state.thresholds[state.currentThresholdVersion]?.label}</strong>
          <span>接收台账 {state.acceptedBatchIds.length} 批 · 失败队列 {stats.failed} 批</span>
          <button onClick={store.resetDemo}>重置演示数据</button>
        </div>
      </section>

      <section className="metrics-grid">
        <MetricCard label="待处理异常" value={stats.open} tone="danger" />
        <MetricCard label="重开（保留原处置）" value={stats.reopened} tone="warn" />
        <MetricCard label="字段待确认冲突" value={stats.conflicts} tone="warn" />
        <MetricCard label="阈值升级待复核" value={stats.reconfirms} tone="ok" />
      </section>

      <section className="workspace two-col">
        <BatchConsole
          state={state}
          ingest={store.ingest}
          retryFailed={store.retryFailed}
        />
        <ActionFeed logs={store.logs} />
      </section>

      <section className="workspace two-col">
        <ThresholdBar state={state} onActivateV2={store.activateV2} />
        <MigrationPanel onMigrate={store.runMigration} />
      </section>

      <section className="records panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">合并后的唯一记录</p>
            <h2>巡检记录 × {records.length}（房间 + 日期 + 班次 唯一）</h2>
          </div>
        </div>
        <div className="record-tiles">
          {records.map((record) => (
            <RecordCard
              key={record.id}
              state={state}
              record={record}
              anomaly={
                state.anomalyIndex[record.id]
                  ? state.anomalies[state.anomalyIndex[record.id]]
                  : null
              }
              decideConflict={store.decideConflict}
              reconfirm={store.reconfirm}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "warn" | "danger";
}) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <i className={`metric-bar metric-${tone}`} />
    </article>
  );
}

function ActionFeed({ logs }: { logs: ActionLog[] }) {
  return (
    <Panel title="合并动作日志" hint="实时反馈">
      {logs.length === 0 ? (
        <p className="muted-text">接入批次、裁决冲突或升级阈值后，此处显示引擎处理结果。</p>
      ) : (
        <ul className="log-list">
          {logs.map((l, i) => (
            <li key={i} className={`log-item log-${l.tone}`}>
              {l.text}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default App;
