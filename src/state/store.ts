import { useCallback, useEffect, useState } from "react";
import {
  applyBatch,
  bumpThresholdVersion,
  migrateLegacy,
  reconfirmRecord,
  resolveAnomaly,
  resolveConflict,
} from "../domain/engine";
import {
  THRESHOLD_V2,
  buildSeedState,
} from "../domain/demo";
import type {
  Actor,
  Batch,
  BatchResult,
  ConflictChoice,
  MergeState,
} from "../domain/types";

const STORAGE_KEY = "hxwl09.mergeState.v1";

function loadInitial(): MergeState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as MergeState;
  } catch {
    // 忽略损坏的本地缓存，回退种子
  }
  return buildSeedState();
}

export interface ActionLog {
  at: number;
  text: string;
  tone: "ok" | "warn" | "danger" | "muted";
}

export function useMergeStore() {
  const [state, setState] = useState<MergeState>(loadInitial);
  const [logs, setLogs] = useState<ActionLog[]>([]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const log = useCallback((text: string, tone: ActionLog["tone"] = "ok") => {
    setLogs((prev) => [{ at: Date.now(), text, tone }, ...prev].slice(0, 30));
  }, []);

  const ingest = useCallback(
    (batch: Batch, opts?: { simulateError?: string }): BatchResult => {
      const result = applyBatch(state, batch, opts);
      setState(result.state);
      if (result.outcome === "accepted" || result.outcome === "replayed") {
        const conflicts = result.reports.reduce(
          (n, r) => n + r.conflictFields.length,
          0
        );
        const anomalies = result.reports
          .map((r) => r.anomaly)
          .filter(Boolean)
          .map((a) => a!.detail);
        const prefix =
          result.outcome === "replayed"
            ? `失败批次「${batch.label}」重试成功`
            : `批次「${batch.label}」已接收`;
        log(
          `${prefix}：合并 ${result.reports.length} 项，${conflicts} 个字段待确认${
            anomalies.length ? `；${anomalies.join("；")}` : ""
          }`,
          conflicts > 0 ? "warn" : "ok"
        );
      } else if (result.outcome === "duplicate") {
        log(`批次「${batch.label}」此前已接收，拒绝重复带入`, "muted");
      } else {
        log(`批次「${batch.label}」写入失败：${result.error}（可在失败队列单独重试）`, "danger");
      }
      return result;
    },
    [state, log]
  );

  const retryFailed = useCallback(
    (batchId: string) => {
      const entry = state.failedBatches[batchId];
      if (!entry) return;
      ingest(entry.batch);
    },
    [state, ingest]
  );

  const decideConflict = useCallback(
    (choice: Omit<ConflictChoice, "decidedAt">) => {      setState((prev) =>
        resolveConflict(
          prev,
          { ...choice, decidedAt: Date.now() },
          { id: `DECISION:${choice.recordKey}:${choice.field}:${Date.now()}` }
        )
      );
      log(
        `冲突裁决：${choice.recordKey} 的字段已按${
          choice.manualValue !== undefined ? "人工终版" : choice.chooseTeam
        }定稿，已重新做粒子判定`,
        "ok"
      );
    },
    [log]
  );

  const closeAnomaly = useCallback(
    (anomalyId: string, disposition: string, team: Actor) => {
      setState((prev) => resolveAnomaly(prev, anomalyId, disposition, team, Date.now()));
      log(`异常 ${anomalyId} 已人工处置关闭：${disposition}`, "ok");
    },
    [log]
  );

  const reconfirm = useCallback(
    (
      recordKey: string,
      decision: { stillExceeds: boolean; note: string; team: Actor }
    ) => {
      setState((prev) =>
        reconfirmRecord(prev, recordKey, { ...decision, at: Date.now() })
      );
      log(
        `旧阈值判定复核完成（${recordKey}）：${decision.stillExceeds ? "确认仍超限" : "确认合格"}`,
        decision.stillExceeds ? "warn" : "ok"
      );
    },
    [log]
  );

  const activateV2 = useCallback(() => {
    setState((prev) => {
      const { state: next, reports } = bumpThresholdVersion(prev, THRESHOLD_V2);
      const reopened = reports.filter((r) => r.action === "reopened").length;
      log(
        `阈值已升级至 v2：${reports.length} 条旧判定重新确认，${reopened} 条已处置异常因仍超限自动重开（原处置保留）`,
        reopened > 0 ? "warn" : "ok"
      );
      return next;
    });
  }, [log]);

  const runMigration = useCallback(
    (rows: Parameters<typeof migrateLegacy>[1]) => {
      const result = migrateLegacy(state, rows);
      setState(result.state);
      if (result.outcome === "duplicate") {
        log("该批旧数据已迁移过，幂等跳过", "muted");
      } else {
        log(
          `旧浏览器数据迁移完成：补上班次与阈值版本 ${rows.length} 条，历史处置保留可查`,
          "ok"
        );
      }
    },
    [state, log]
  );

  const resetDemo = useCallback(() => {
    const fresh = buildSeedState();
    setState(fresh);
    setLogs([]);
    log("已重置为演示初始数据", "muted");
  }, [log]);

  return {
    state,
    logs,
    ingest,
    retryFailed,
    decideConflict,
    closeAnomaly,
    reconfirm,
    activateV2,
    runMigration,
    resetDemo,
  };
}
