import "./styles.css";
import { useDomainStore } from "./domain/store";
import {
  listExceptions,
  listRecords,
  metrics,
  pendingConflicts,
} from "./domain/selectors";
import { ConflictPanel } from "./components/ConflictPanel";
import { ExceptionCard } from "./components/ExceptionCard";
import { RecordCard } from "./components/RecordCard";
import { LedgerPanel } from "./components/LedgerPanel";
import { AuditLog, IngestPanel } from "./components/IngestPanel";

function MetricCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <i className={tone} />
    </article>
  );
}

export default function App() {
  const store = useDomainStore();
  const { state, outbox } = store;
  const m = metrics(state);
  const records = listRecords(state);
  const conflicts = pendingConflicts(state);
  const exceptions = listExceptions(state);

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-09 · 交接班离线合并</p>
          <h1>半导体洁净室巡检</h1>
          <p className="subtitle">
            同一房间同一班次只留一条记录：字段级合并、各自保留来源；同字段两班同改进待确认。
            已处置异常不被旧批次回退，新计数超限自动重开并保留处置；阈值升级旧判定重新确认；
            失败批次单独重试，已接收批次不重复带入，旧浏览器数据补齐班次与阈值版本后可迁移查询。
          </p>
        </div>
        <div className="stack-card">
          <span>规则开关</span>
          <strong>当前阈值版本：{state.currentThresholdVersion}</strong>
          <div className="row-actions">
            <button className="primary" onClick={store.runDemo}>
              载入交接演示
            </button>
            <button onClick={store.reset}>清空重建</button>
          </div>
        </div>
      </section>

      <section className="metrics-grid">
        <MetricCard label="巡检记录（房间+班次唯一）" value={m.rooms} tone="status-ok" />
        <MetricCard label="待确认字段冲突" value={m.conflicts} tone="status-watch" />
        <MetricCard label="待处理异常" value={m.openExceptions} tone="status-danger" />
        <MetricCard label="阈值重确认 / 失败批次" value={m.reconfirm + m.failedBatches} tone="status-watch" />
      </section>

      <ConflictPanel
        items={conflicts}
        onChoose={(recordId, conflictId, batchId) =>
          store.actions.chooseConflictVersion(recordId, conflictId, batchId, "班组长")
        }
      />

      <section className="panel" style={{ marginBottom: 20 }}>
        <div className="section-heading">
          <div>
            <p>巡检记录与异常处理已接起来</p>
            <h2>异常时间线（处置永久保留，重开可追溯）</h2>
          </div>
        </div>
        <div className="exception-grid">
          {exceptions.length === 0 && <p className="empty">暂无异常。粒子计数超过当前阈值版本时自动打开。</p>}
          {exceptions.map((exp) => (
            <ExceptionCard
              key={exp.id}
              exp={exp}
              onResolve={(id, note) => store.actions.closeException(id, note, "厂务工程师")}
              onReconfirm={(id, exceeded) => store.actions.reconfirm(id, exceeded, "班组长")}
            />
          ))}
        </div>
      </section>

      <IngestPanel
        state={state}
        onReceive={store.receive}
        failNext={store.failNext}
        onToggleFail={store.setFailNext}
        onImportLegacy={store.actions.importLegacy}
        onUpgrade={() =>
          store.actions.upgrade({
            version: "v2026-03",
            effectiveAt: Date.now(),
            note: "制程收紧",
            limits: { "ISO 5": 3000, "ISO 6": 30000, "ISO 7": 352000, 黄光区: 300000 },
          })
        }
      />

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="section-heading">
          <div>
            <p>字段级合并结果</p>
            <h2>记录明细（每格标注来源批次/终端/人/阈值版本）</h2>
          </div>
        </div>
        <div className="record-grid">
          {records.length === 0 && <p className="empty">还没有记录，点「载入交接演示」查看完整场景。</p>}
          {records.map((rec) => (
            <RecordCard key={rec.id} state={state} record={rec} />
          ))}
        </div>
      </section>

      <div style={{ height: 20 }} />
      <LedgerPanel ledger={state.ledger} outbox={outbox} onRetry={store.retry} onDismiss={store.removeFromOutbox} />

      <div style={{ height: 20 }} />
      <AuditLog events={state.audit} />
    </main>
  );
}
