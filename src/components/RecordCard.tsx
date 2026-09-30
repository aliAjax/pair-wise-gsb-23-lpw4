import { useState } from "react";
import { FIELD_KEYS } from "../domain/engine";
import { particleLimit } from "../domain/thresholds";
import type {
  Actor,
  Anomaly,
  FieldKey,
  InspectionRecord,
  MergeState,
  Team,
} from "../domain/types";
import {
  ActorTag,
  SourceLine,
  StatusPill,
  fieldLabel,
  fmtDateTime,
} from "./ui";

interface RecordProps {
  state: MergeState;
  record: InspectionRecord;
  anomaly: Anomaly | null;
  decideConflict: (c: {
    recordKey: string;
    field: FieldKey;
    chooseTeam?: Team;
    manualValue?: string;
    decidedBy: Actor;
  }) => void;
  reconfirm: (
    recordKey: string,
    decision: { stillExceeds: boolean; note: string; team: Actor }
  ) => void;
}

export function RecordCard({ state, record, anomaly, decideConflict, reconfirm }: RecordProps) {
  const conflictFields = FIELD_KEYS.filter(
    (k) => record.fields[k].candidates.length >= 2
  );
  const limit = record.isoClass
    ? particleLimit(
        state.thresholds,
        record.judgedThresholdVersion ?? state.currentThresholdVersion,
        record.isoClass
      )
    : null;

  return (
    <article
      className={`record-tile ${conflictFields.length ? "has-conflict" : ""} ${
        record.needsReconfirm ? "needs-reconfirm" : ""
      }`}
    >
      <header className="record-head">
        <div>
          <h3>
            {record.roomId}
            <span className="shift-badge">{record.shift}</span>
            {record.legacy && <span className="legacy-badge">旧机迁移</span>}
          </h3>
          <p className="muted-text">
            巡检日期 {record.date} · 合并键 {record.date}#{record.shift}#
            {record.roomId} · 修订 {record.revision} 次
            {record.isoClass ? ` · ${record.isoClass}` : ""}
            {limit !== null && record.fields.particleCount.accepted
              ? ` · 当前限值 ${limit.toLocaleString()} 个/m³`
              : ""}
          </p>
        </div>
        <div className="record-head-right">
          {anomaly && <StatusPill status={anomaly.status} />}
          {conflictFields.length > 0 && (
            <span className="conflict-badge">{conflictFields.length} 个字段待确认</span>
          )}
          {record.needsReconfirm && (
            <span className="reconfirm-badge">阈值升级·待复核</span>
          )}
        </div>
      </header>

      <div className="field-rows">
        {FIELD_KEYS.map((key) => {
          const fs = record.fields[key];
          if (!fs.accepted && fs.candidates.length === 0) return null;
          const isConflict = fs.candidates.length >= 2;
          return (
            <div key={key} className={`field-row ${isConflict ? "conflict" : ""}`}>
              <div className="field-name">{fieldLabel(key)}</div>
              <div className="field-body">
                {isConflict ? (
                  <ConflictCell
                    fieldKey={key}
                    record={record}
                    onDecide={(choice) =>
                      decideConflict({ recordKey: record.id, field: key, ...choice })
                    }
                  />
                ) : (
                  fs.accepted && (
                    <div className="accepted-line">
                      <span className="field-value">{fs.accepted.value}</span>
                      <SourceLine v={fs.accepted} />
                    </div>
                  )
                )}
              </div>
            </div>
          );
        })}
      </div>

      {anomaly && (
        <AnomalyBlock anomaly={anomaly} />
      )}

      {record.needsReconfirm && (
        <ReconfirmBar
          onReconfirm={(d) => reconfirm(record.id, d)}
        />
      )}
    </article>
  );
}

function ConflictCell({
  fieldKey,
  record,
  onDecide,
}: {
  fieldKey: FieldKey;
  record: InspectionRecord;
  onDecide: (c: { chooseTeam?: Team; manualValue?: string; decidedBy: Actor }) => void;
}) {
  const fs = record.fields[fieldKey];
  const [manual, setManual] = useState("");
  const [decidedBy, setDecidedBy] = useState<Actor>("班组长");
  return (
    <div className="conflict-cell">
      <div className="conflict-candidates">
        {fs.candidates.map((c) => (
          <div
            key={`${c.team}-${c.batchId}`}
            className={`candidate ${
              fs.accepted?.team === c.team ? "current-accepted" : ""
            }`}
          >
            <span className="field-value">{c.value}</span>
            <SourceLine v={c} />
            <button
              onClick={() => onDecide({ chooseTeam: c.team, decidedBy })}
            >
              采用{c.team}版本
            </button>
          </div>
        ))}
      </div>
      <div className="conflict-manual">
        <input
          placeholder="或输入人工终版值"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <select value={decidedBy} onChange={(e) => setDecidedBy(e.target.value as Actor)}>
          <option value="班组长">班组长裁决</option>
          <option value="厂务工程师">厂务工程师裁决</option>
          <option value="早班">早班裁决</option>
          <option value="晚班">晚班裁决</option>
          <option value="夜班">夜班裁决</option>
        </select>
        <button
          disabled={!manual.trim()}
          onClick={() => onDecide({ manualValue: manual.trim(), decidedBy })}
        >
          定稿为终版
        </button>
      </div>
    </div>
  );
}

function AnomalyBlock({ anomaly }: { anomaly: Anomaly }) {
  const [open, setOpen] = useState(true);
  return (
    <div className={`anomaly-block ${anomaly.status}`}>
      <button className="anomaly-toggle" onClick={() => setOpen((v) => !v)}>
        <StatusPill status={anomaly.status} />
        <strong>
          异常单 {anomaly.id} · 判定阈值 v{anomaly.judgedThresholdVersion}
        </strong>
        <span className="muted-text">{anomaly.events.length} 条处理记录（只追加）</span>
        <span className="chevron">{open ? "收起 ▲" : "展开 ▼"}</span>
      </button>
      {open && (
        <ol className="event-list">
          {anomaly.events.map((e, i) => (
            <li key={i} className={`event event-${e.type}`}>
              <div className="event-head">
                <span className={`event-type et-${e.type}`}>{eventLabel(e.type)}</span>
                <ActorTag actor={e.team} />
                <span className="muted-text">
                  {fmtDateTime(e.at)} · v{e.thresholdVersion}
                  {e.batchId ? ` · ${e.batchId}` : ""}
                </span>
              </div>
              <p>{e.detail}</p>
              {e.disposition && (
                <p className="disposition-line">↳ 原处置保留：{e.disposition}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function eventLabel(type: string): string {
  switch (type) {
    case "open":
      return "打开";
    case "resolve":
      return "处置关闭";
    case "reopen":
      return "再次超限重开";
    case "ignored-stale":
      return "旧批次忽略";
    case "reconfirm":
      return "阈值复核";
    default:
      return type;
  }
}

function ReconfirmBar({
  onReconfirm,
}: {
  onReconfirm: (d: { stillExceeds: boolean; note: string; team: Actor }) => void;
}) {
  const [note, setNote] = useState("");
  const [team, setTeam] = useState<Actor>("班组长");
  return (
    <div className="reconfirm-bar">
      <span>该记录的粒子判定基于旧阈值版本，需人工重新确认：</span>
      <input
        placeholder="复核备注（如：现场复测数值）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <select value={team} onChange={(e) => setTeam(e.target.value as Actor)}>
        <option value="班组长">班组长</option>
        <option value="厂务工程师">厂务工程师</option>
        <option value="早班">早班</option>
        <option value="晚班">晚班</option>
        <option value="夜班">夜班</option>
      </select>
      <button
        onClick={() => onReconfirm({ stillExceeds: true, note: note || "复核确认仍超限", team })}
      >
        确认仍超限（重开）
      </button>
      <button
        className="primary-action"
        onClick={() => onReconfirm({ stillExceeds: false, note: note || "复核合格", team })}
      >
        确认合格（关闭）
      </button>
    </div>
  );
}
