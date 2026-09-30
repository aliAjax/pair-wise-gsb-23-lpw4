// 领域状态的 React 绑定：接收批次、人工处置、阈值升级、失败重试、迁移
import { useCallback, useMemo, useState } from "react";
import {
  createDomainState,
  receiveBatch,
  reconfirmException,
  resolveConflict,
  resolveException,
  upgradeThreshold,
} from "./engine";
import { loadOutbox, loadState, saveOutbox, saveState } from "./storage";
import { THRESHOLDS, legacyBatch } from "./seed";
import { demoTimeline, replayTimeline } from "./timeline";
import { DomainState, SyncBatch, ThresholdVersion } from "./types";

function boot(): { state: DomainState; outbox: SyncBatch[] } {
  const saved = loadState();
  if (saved) return { state: saved, outbox: loadOutbox() };
  return {
    state: createDomainState(THRESHOLDS, "v2024-01", Date.now()),
    outbox: [],
  };
}

export function useDomainStore() {
  const [{ state, outbox }, setStore] = useState(boot);
  const [failNext, setFailNext] = useState(false);

  const commit = useCallback((next: DomainState, queue: SyncBatch[]) => {
    saveState(next);
    saveOutbox(queue);
    setStore({ state: next, outbox: queue });
  }, []);

  const receive = useCallback(
    (batch: SyncBatch) => {
      let result: ReturnType<typeof receiveBatch>;
      if (failNext) {
        result = receiveBatch(state, batch, {
          now: Date.now(),
          persist: () => {
            throw new Error("模拟离线终端写入失败（存储不可用）");
          },
        });
        setFailNext(false);
      } else {
        result = receiveBatch(state, batch, { now: Date.now(), persist: saveState });
      }
      const { state: next, result: r } = result;
      const queue =
        r.outcome === "failed" && !outbox.some((b) => b.batchId === batch.batchId)
          ? [...outbox, batch]
          : outbox;
      commit(next, queue);
      return r;
    },
    [state, outbox, failNext, commit]
  );

  const retry = useCallback(
    (batchId: string) => {
      const batch = outbox.find((b) => b.batchId === batchId);
      if (!batch) return;
      const { state: next, result: r } = receiveBatch(state, batch, {
        now: Date.now(),
        persist: saveState,
      });
      const queue = r.outcome === "accepted" ? outbox.filter((b) => b.batchId !== batchId) : outbox;
      commit(next, queue);
      return r;
    },
    [state, outbox, commit]
  );

  const removeFromOutbox = useCallback(
    (batchId: string) => commit(state, outbox.filter((b) => b.batchId !== batchId)),
    [state, outbox, commit]
  );

  const runDemo = useCallback(() => {
    const { state: s, outbox: queue } = replayTimeline(
      demoTimeline(),
      createDomainState(THRESHOLDS, "v2024-01", Date.now())
    );
    commit(s, queue);
  }, [commit]);

  const reset = useCallback(() => {
    localStorage.removeItem("hxwl09.state.v1");
    localStorage.removeItem("hxwl09.outbox.v1");
    commit(createDomainState(THRESHOLDS, "v2024-01", Date.now()), []);
  }, [commit]);

  const actions = useMemo(
    () => ({
      chooseConflictVersion(recordId: string, conflictId: string, batchId: string, operator: string) {
        commit(resolveConflict(state, recordId, conflictId, batchId, operator, Date.now()), outbox);
      },
      closeException(recordId: string, note: string, operator: string) {
        commit(resolveException(state, recordId, note, operator, state.currentThresholdVersion, Date.now()), outbox);
      },
      reconfirm(recordId: string, exceeded: boolean, operator: string) {
        commit(reconfirmException(state, recordId, exceeded, operator, Date.now()), outbox);
      },
      upgrade(next: ThresholdVersion) {
        commit(upgradeThreshold(state, next, Date.now()), outbox);
      },
      importLegacy() {
        const r = receiveBatch(state, legacyBatch(), { now: Date.now(), persist: saveState });
        commit(r.state, outbox);
      },
    }),
    [state, outbox, commit]
  );

  return { state, outbox, receive, retry, removeFromOutbox, runDemo, reset, actions, failNext, setFailNext };
}
