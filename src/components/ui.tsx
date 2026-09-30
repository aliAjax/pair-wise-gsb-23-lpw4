import type { ReactNode } from "react";
import { FIELD_LABELS } from "../domain/types";
import type {
  Actor,
  AnomalyStatus,
  BatchOutcome,
  FieldKey,
  FieldVersion,
  Team,
} from "../domain/types";

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours()
  )}:${p(d.getUTCMinutes())}`;
}

export const TEAM_BADGE: Record<Team, string> = {
  早班: "team-morning",
  晚班: "team-evening",
  夜班: "team-night",
};

const ROLE_BADGE: Record<string, string> = {
  巡检员: "role-inspector",
  厂务工程师: "role-facility",
  班组长: "role-lead",
};

export function TeamTag({ team, legacy }: { team: Team; legacy?: boolean }) {
  return (
    <span className={`team-tag ${TEAM_BADGE[team]}`}>
      {team}
      {legacy ? "·旧机" : ""}
    </span>
  );
}

/** 操作人标签：班组或交接角色均可 */
export function ActorTag({ actor }: { actor: Actor }) {
  const cls = ROLE_BADGE[actor] ?? TEAM_BADGE[actor as Team] ?? "role-inspector";
  return <span className={`team-tag ${cls}`}>{actor}</span>;
}

export const ANOMALY_META: Record<
  AnomalyStatus,
  { label: string; cls: string }
> = {
  open: { label: "待处理", cls: "ax-open" },
  reopened: { label: "重新打开", cls: "ax-reopened" },
  resolved: { label: "已处置", cls: "ax-resolved" },
};

export function StatusPill({ status }: { status: AnomalyStatus }) {
  const meta = ANOMALY_META[status];
  return <span className={`status-pill ${meta.cls}`}>{meta.label}</span>;
}

export function fieldLabel(key: FieldKey): string {
  return FIELD_LABELS[key];
}

export function SourceLine({ v }: { v: FieldVersion }) {
  return (
    <span className="source-line">
      <TeamTag team={v.team} legacy={v.legacy} />
      {fmtTime(v.editedAt)} · v{v.thresholdVersion} · {v.batchId}
    </span>
  );
}

export function Panel({
  title,
  hint,
  extra,
  children,
}: {
  title: string;
  hint?: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          {hint ? <p className="eyebrow">{hint}</p> : null}
          <h2>{title}</h2>
        </div>
        {extra}
      </div>
      {children}
    </section>
  );
}

export const OUTCOME_META: Record<
  BatchOutcome,
  { label: string; cls: string }
> = {
  accepted: { label: "已接收", cls: "out-accepted" },
  replayed: { label: "重试接收", cls: "out-replayed" },
  duplicate: { label: "重复拒绝", cls: "out-duplicate" },
  failed: { label: "写入失败", cls: "out-failed" },
};
