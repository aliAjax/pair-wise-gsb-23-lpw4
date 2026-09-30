import { useState } from "react";
import { LEGACY_SAMPLE } from "../domain/demo";
import type { LegacyInput, Shift } from "../domain/types";
import { Panel } from "./ui";

export function MigrationPanel({
  onMigrate,
}: {
  onMigrate: (rows: LegacyInput[]) => void;
}) {
  const sample = LEGACY_SAMPLE[0];
  const [roomId, setRoomId] = useState(sample.roomId);
  const [date, setDate] = useState(sample.date);
  const [shift, setShift] = useState<Shift>(sample.shift);
  const [thresholdVersion, setThresholdVersion] = useState(sample.thresholdVersion);
  const [particleCount, setParticleCount] = useState(sample.fields.particleCount);
  const [note, setNote] = useState(sample.fields.handlingNote ?? "");
  const [isoClass, setIsoClass] = useState(sample.fields.isoClass);
  const [disposition, setDisposition] = useState(
    sample.pastDisposition.note
  );
  const [capturedAtText, setCapturedAtText] = useState(sample.capturedAtText);
  const [disposedAtText, setDisposedAtText] = useState(
    sample.pastDisposition.disposedAtText
  );

  const submit = () => {
    const row: LegacyInput = {
      roomId: roomId.trim(),
      date,
      shift,
      thresholdVersion,
      capturedAt: Date.parse(capturedAtText.replace(" ", "T") + ":00Z"),
      fields: {
        isoClass,
        particleCount,
        handlingNote: note,
      },
      pastDisposition: disposition.trim()
        ? {
            note: disposition.trim(),
            disposedAt: Date.parse(disposedAtText.replace(" ", "T") + ":00Z"),
          }
        : undefined,
    };
    if (Number.isNaN(row.capturedAt)) return;
    onMigrate([row]);
  };

  return (
    <Panel title="旧浏览器数据补录" hint="迁移工具">
      <p className="muted-text">
        旧终端离线数据没有班次与阈值版本。补全后并入同一合并体系：同一房间班次仍只留一条，
        历史处置作为只追加事件保留可查；若补入的阈值版本已过期，自动标记待复核。
      </p>
      <div className="migration-grid">
        <label>
          <span>房间编号</span>
          <input value={roomId} onChange={(e) => setRoomId(e.target.value)} />
        </label>
        <label>
          <span>巡检日期</span>
          <input value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          <span>补上班次</span>
          <select value={shift} onChange={(e) => setShift(e.target.value as Shift)}>
            <option value="早班">早班</option>
            <option value="晚班">晚班</option>
            <option value="夜班">夜班</option>
          </select>
        </label>
        <label>
          <span>补阈值版本</span>
          <select
            value={thresholdVersion}
            onChange={(e) => setThresholdVersion(Number(e.target.value))}
          >
            <option value={1}>v1 常规限值</option>
            <option value={2}>v2 加严限值</option>
          </select>
        </label>
        <label>
          <span>洁净等级</span>
          <input value={isoClass} onChange={(e) => setIsoClass(e.target.value)} />
        </label>
        <label>
          <span>粒子计数</span>
          <input value={particleCount} onChange={(e) => setParticleCount(e.target.value)} />
        </label>
        <label className="span-2">
          <span>巡检备注</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <label>
          <span>采集时间(UTC)</span>
          <input
            value={capturedAtText}
            onChange={(e) => setCapturedAtText(e.target.value)}
          />
        </label>
        <label>
          <span>历史处置内容</span>
          <input
            value={disposition}
            onChange={(e) => setDisposition(e.target.value)}
          />
        </label>
        <label>
          <span>处置时间(UTC)</span>
          <input
            value={disposedAtText}
            onChange={(e) => setDisposedAtText(e.target.value)}
          />
        </label>
      </div>
      <div className="threshold-actions">
        <button className="primary-action" onClick={submit}>
          补全班次与阈值版本并迁入
        </button>
      </div>
    </Panel>
  );
}
