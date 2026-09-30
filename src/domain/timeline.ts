// 交接场景的重放时间线：显式给出每步的「回网接收时刻」。
// 注意 preparedAt（现场封包时间）与 receivedAt（回网接收时间）不同 ——
// 旧批次守卫正是按现场时间判定的。
import { receiveBatch, resolveException, upgradeThreshold } from "./engine";
import { THRESHOLDS, failingBatch, legacyBatch } from "./seed";
import { DomainState, SyncBatch, recordKey } from "./types";
import {
  demoBatchesAfterResolve,
  demoBatchesBeforeResolve,
} from "./seed";

export type TimelineStep =
  | { kind: "batch"; batch: SyncBatch; receivedAt: number; failWrite?: boolean }
  | {
      kind: "resolve";
      recordId: string;
      note: string;
      operator: string;
      thresholdVersion: string;
      at: number;
    }
  | { kind: "threshold"; index: 1; at: number };

const D = "2026-09-30";
const NIGHT = recordKey(D, "夜班", "CR-1201");
const utc = (s: string) => Date.parse(`${D}T${s}Z`);

export function demoTimeline(): TimelineStep[] {
  return [
    ...demoBatchesBeforeResolve().map((batch, i) => ({
      kind: "batch" as const,
      batch,
      receivedAt: [utc("07:00:00"), utc("07:02:00"), utc("07:03:00"), utc("07:10:00")][i],
    })),
    {
      kind: "resolve",
      recordId: NIGHT,
      note: "已更换高效过滤器，现场复检后交接",
      operator: "厂务工程师",
      thresholdVersion: "v2024-01",
      at: utc("07:30:00"),
    },
    // 终端C 的旧批次 07:40 才回网（封包 06:50，早于处置）
    { kind: "batch", batch: demoBatchesAfterResolve()[0], receivedAt: utc("07:40:00") },
    // 09:10 的新复测 09:20 回网
    { kind: "batch", batch: demoBatchesAfterResolve()[1], receivedAt: utc("09:20:00") },
    // 早班房间
    { kind: "batch", batch: demoBatchesAfterResolve()[2], receivedAt: utc("09:25:00") },
    // 稳定房间
    { kind: "batch", batch: demoBatchesAfterResolve()[3], receivedAt: utc("16:00:00") },
    // 重复批次（重复回网，必须去重）
    { kind: "batch", batch: demoBatchesAfterResolve()[4], receivedAt: utc("18:00:00") },
    // 首次写入失败
    { kind: "batch", batch: failingBatch(), receivedAt: utc("08:00:00"), failWrite: true },
    // 旧浏览器迁移
    { kind: "batch", batch: legacyBatch(), receivedAt: utc("12:00:00") },
    // 阈值升级
    { kind: "threshold", index: 1, at: utc("13:00:00") },
  ];
}

export interface ReplayResult {
  state: DomainState;
  outbox: SyncBatch[];
}

export function replayTimeline(
  steps: TimelineStep[],
  initial: DomainState
): ReplayResult {
  let s = initial;
  const outbox: SyncBatch[] = [];
  for (const step of steps) {
    if (step.kind === "batch") {
      const r = receiveBatch(s, step.batch, {
        now: step.receivedAt,
        persist: step.failWrite ? () => { throw new Error("存储不可用"); } : undefined,
      });
      s = r.state;
      if (r.result.outcome === "failed" && step.failWrite) outbox.push(step.batch);
    } else if (step.kind === "resolve") {
      s = resolveException(s, step.recordId, step.note, step.operator, step.thresholdVersion, step.at);
    } else {
      s = upgradeThreshold(s, THRESHOLDS[step.index], step.at);
    }
  }
  return { state: s, outbox };
}

export { createDomainState } from "./engine";
