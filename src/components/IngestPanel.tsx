import { useState } from "react";
import { AuditEvent, DomainState, FieldKey, RoomClass, Shift, SyncBatch } from "../domain/types";
import type { BatchResult } from "../domain/engine";

const SHIFTS: Shift[] = ["夜班", "早班", "中班"];
const ROOM_CLASSES: RoomClass[] = ["ISO 5", "ISO 6", "ISO 7", "黄光区"];

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

export function IngestPanel({
  state,
  onReceive,
  failNext,
  onToggleFail,
  onImportLegacy,
  onUpgrade,
}: {
  state: DomainState;
  onReceive: (b: SyncBatch) => BatchResult;
  failNext: boolean;
  onToggleFail: (v: boolean) => void;
  onImportLegacy: () => void;
  onUpgrade: () => void;
}) {
  const [roomId, setRoomId] = useState("CR-1201");
  const [date, setDate] = useState("2026-09-30");
  const [shift, setShift] = useState<Shift>("夜班");
  const [terminal, setTerminal] = useState("离线终端B");
  const [operator, setOperator] = useState("李早班");
  const [roomClass, setRoomClass] = useState<RoomClass>("ISO 5");
  const [particle, setParticle] = useState("");
  const [note, setNote] = useState("");
  const [equip, setEquip] = useState("");
  const [feedback, setFeedback] = useState("");
  const [seq, setSeq] = useState(100);
  const [staleBase, setStaleBase] = useState(false);

  const send = () => {
    const fields: Partial<Record<FieldKey, string | number>> = {};
    if (particle.trim()) fields.particleCount = Number(particle);
    if (note.trim()) fields.handlingNote = note;
    if (equip.trim()) fields.equipmentStatus = equip;
    const id = `MANUAL-${seq}`;
    setSeq(seq + 1);
    // 默认模拟「封包前已同步」的离线终端：携带当前字段版本，正常更新；
    // 勾选旧版本则模拟未同步终端与他人并发改同一字段 → 停在待确认
    const existing = state.records[`${date}#${shift}#${roomId}`];
    const baseFieldRevisions: Partial<Record<FieldKey, number>> = {};
    if (!staleBase && existing) {
      for (const key of Object.keys(fields) as FieldKey[]) {
        baseFieldRevisions[key] = existing.fields[key]?.fieldRevision ?? 0;
      }
    }
    const batch: SyncBatch = {
      batchId: id,
      terminal,
      operator,
      shift,
      thresholdVersion: state.currentThresholdVersion,
      preparedAt: Date.now(),
      ops: [
        {
          kind: "record-write",
          date,
          shift,
          roomId,
          roomClass,
          baseRevision: staleBase || !existing ? 0 : existing.revision,
          baseFieldRevisions,
          fields,
        },
      ],
    };
    const r = onReceive(batch);
    const conflictTip = r.conflictIds.length > 0 ? `，${r.conflictIds.length} 个字段停在待确认` : "";
    setFeedback(
      r.outcome === "accepted"
        ? `批次 ${id} 已接收${conflictTip}`
        : r.outcome === "duplicate"
          ? `批次 ${id} 重复，已忽略`
          : `批次 ${id} 失败：${r.error ?? ""}（可重试）`
    );
    setParticle("");
    setNote("");
    setEquip("");
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>模拟离线终端回网</p>
          <h2>封包接收</h2>
        </div>
        <div className="row-actions">
          <label className="inline-check">
            <input type="checkbox" checked={failNext} onChange={(e) => onToggleFail(e.target.checked)} />
            下一批写入失败
          </label>
          <label className="inline-check">
            <input type="checkbox" checked={staleBase} onChange={(e) => setStaleBase(e.target.checked)} />
            未同步旧版本封包（与他人同改会冲突）
          </label>
          <button className="mini" onClick={onImportLegacy}>
            导入旧浏览器数据
          </button>
          <button className="mini" onClick={onUpgrade}>
            升级阈值到 v2026-03
          </button>
        </div>
      </div>
      <div className="ingest-grid">
        <label>
          <span>房间</span>
          <input value={roomId} onChange={(e) => setRoomId(e.target.value)} />
        </label>
        <label>
          <span>日期</span>
          <input value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          <span>补录班次</span>
          <select value={shift} onChange={(e) => setShift(e.target.value as Shift)}>
            {SHIFTS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          <span>终端</span>
          <input value={terminal} onChange={(e) => setTerminal(e.target.value)} />
        </label>
        <label>
          <span>操作人</span>
          <input value={operator} onChange={(e) => setOperator(e.target.value)} />
        </label>
        <label>
          <span>洁净等级</span>
          <select value={roomClass} onChange={(e) => setRoomClass(e.target.value as RoomClass)}>
            {ROOM_CLASSES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          <span>粒子计数（可空）</span>
          <input value={particle} onChange={(e) => setParticle(e.target.value)} placeholder="如 4600" />
        </label>
        <label>
          <span>设备状态（可空）</span>
          <input value={equip} onChange={(e) => setEquip(e.target.value)} />
        </label>
        <label className="wide">
          <span>处理备注（可空，与另一班同改会进待确认）</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <div className="row-actions">
        <button className="primary-action" onClick={send}>
          封包并回网接收
        </button>
        {feedback && <span className="feedback">{feedback}</span>}
        <span className="muted">当前判定阈值版本：{state.currentThresholdVersion}</span>
      </div>
    </section>
  );
}

const KIND_LABEL: Record<AuditEvent["kind"], string> = {
  merge: "合并",
  conflict: "冲突",
  exception: "异常",
  threshold: "阈值",
  batch: "批次",
  legacy: "迁移",
};

export function AuditLog({ events }: { events: AuditEvent[] }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>字段级合并 / 状态机审计</p>
          <h2>审计流水</h2>
        </div>
      </div>
      <ul className="audit-list">
        {events.slice(0, 40).map((e) => (
          <li key={e.id}>
            <span className={`audit-kind kind-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
            <span className="muted">{fmtTime(e.at)}</span>
            <span>{e.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
