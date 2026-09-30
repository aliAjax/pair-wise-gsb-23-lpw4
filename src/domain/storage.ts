// 持久化 + 离线队列（localStorage）。
// 回网时逐批接收：失败批次留在 outbox 可单独重试；已接收批次靠台账 batchId 去重。
import { DomainState, SyncBatch } from "./types";

const STATE_KEY = "hxwl09.state.v1";
const OUTBOX_KEY = "hxwl09.outbox.v1";

export function saveState(state: DomainState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (e) {
    // 容量满 / 隐私模式等：交给上层按整批写入失败处理
    throw new Error(e instanceof Error ? e.message : "状态持久化失败");
  }
}

export function loadState(): DomainState | undefined {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? (JSON.parse(raw) as DomainState) : undefined;
  } catch {
    return undefined;
  }
}

export function loadOutbox(): SyncBatch[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    return raw ? (JSON.parse(raw) as SyncBatch[]) : [];
  } catch {
    return [];
  }
}

export function saveOutbox(queue: SyncBatch[]): void {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(queue));
}
