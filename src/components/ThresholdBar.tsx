import type { MergeState } from "../domain/types";
import { THRESHOLD_V2 } from "../domain/demo";
import { Panel } from "./ui";

export function ThresholdBar({
  state,
  onActivateV2,
}: {
  state: MergeState;
  onActivateV2: () => void;
}) {
  const versions = Object.values(state.thresholds).sort((a, b) => a.version - b.version);
  const pendingCount = Object.values(state.records).filter(
    (r) => r.needsReconfirm
  ).length;
  const v2Active = state.currentThresholdVersion >= THRESHOLD_V2.version;

  return (
    <Panel title="洁净等级阈值版本" hint="版本治理">
      <div className="threshold-grid">
        {versions.map((t) => (
          <div
            key={t.version}
            className={`threshold-card ${
              t.version === state.currentThresholdVersion ? "current" : ""
            }`}
          >
            <header>
              <strong>{t.label}</strong>
              {t.version === state.currentThresholdVersion && (
                <span className="out-pill out-accepted">当前生效</span>
              )}
            </header>
            <ul>
              {Object.entries(t.limits).map(([cls, limit]) => (
                <li key={cls}>
                  {cls}：{limit.toLocaleString()} 个/m³
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="threshold-actions">
        <button className="primary-action" disabled={v2Active} onClick={onActivateV2}>
          {v2Active ? "v2 已生效" : "发布 v2 加严阈值（旧判定将全部要求重新确认）"}
        </button>
        <span className="muted-text">
          {pendingCount > 0
            ? `当前有 ${pendingCount} 条记录的旧判定待复核`
            : "升级后系统自动按新阈值复核，并保留人工确认入口"}
        </span>
      </div>
    </Panel>
  );
}
