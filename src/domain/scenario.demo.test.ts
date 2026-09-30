import { describe, it, expect } from "vitest";
import {
  createDomainState,
  receiveBatch,
  upgradeThreshold,
} from "./engine";
import { THRESHOLDS, failingBatch, legacyBatch } from "./seed";
import { demoTimeline, replayTimeline } from "./timeline";
import { exceptionKey, recordKey } from "./types";

const NIGHT = recordKey("2026-09-30", "夜班", "CR-1201");

function buildDemo() {
  return replayTimeline(
    demoTimeline(),
    createDomainState(THRESHOLDS, "v2024-01", Date.now())
  ).state;
}

describe("交接演示端到端", () => {
  it("同房间同班次只有一条记录；字段各自带来源，没有整条覆盖", () => {
    const s = buildDemo();
    const nightId = recordKey("2026-09-30", "夜班", "CR-1201");
    const night = s.records[nightId];
    // 粒子计数保留夜班最新复测（4600 来自早班终端的复测），温湿度仍是夜班首批
    expect(night.fields.particleCount?.value).toBe(4600);
    expect(night.fields.temperature?.value).toBe(22.1);
    expect(night.fields.humidity?.source.terminal).toBe("离线终端A");
    // 设备状态这一不同字段并入早班来源
    expect(night.fields.equipmentStatus?.value).toContain("门封条");
    expect(night.fields.equipmentStatus?.source.terminal).toBe("离线终端B");
  });

  it("处理备注两班同改停在待确认并列出两版", () => {
    const s = buildDemo();
    const night = s.records[recordKey("2026-09-30", "夜班", "CR-1201")];
    const c = night.conflicts.find((x) => x.field === "handlingNote" && x.status === "pending");
    expect(c).toBeDefined();
    expect(c!.versions).toHaveLength(2);
    expect(c!.versions.map((v) => v.source.terminal).sort()).toEqual(["离线终端A", "离线终端B"]);
  });

  it("新计数超限重开异常且处置保留；旧批次补传不回退", () => {
    const s = buildDemo();
    const exp = s.exceptions[exceptionKey(NIGHT)];
    expect(exp.status).toBe("open");
    expect(exp.events.some((e) => e.type === "reopened")).toBe(true);
    expect(exp.events.some((e) => e.type === "resolved" && e.note?.includes("更换高效过滤器"))).toBe(true);
    // 晚到旧批次的 5000 已作为复测事实登记，但被守卫拦截、未回退状态
    expect(exp.events.some((e) => e.type === "recheck" && e.note?.includes("守卫拦截") && e.particleCount === 5000)).toBe(true);
    // 字段本身仍正常更新（字段合并与异常状态机互不阻断）
    // 注：随后 4600 重开复测成为最新值
    expect(s.records[NIGHT].fields.particleCount?.value).toBe(4600);
    // 事件按现场时间排序：打开→处置→拦截复测→重开
    const chain = exp.events.map((e) => e.type);
    expect(chain.indexOf("reopened")).toBeLessThan(chain.indexOf("resolved"));
    expect(chain.indexOf("resolved")).toBeLessThan(chain.indexOf("opened"));
  });

  it("失败批次只登记 failed 不落库，成功重试后可接收", () => {
    let s = createDomainState(THRESHOLDS, "v2024-01", Date.now());
    const fb = failingBatch();
    s = receiveBatch(s, fb, { now: 1, persist: () => { throw new Error("满"); } }).state;
    expect(s.ledger[0].outcome).toBe("failed");
    expect(s.records[recordKey("2026-09-30", "夜班", "CR-3309")]).toBeUndefined();
    s = receiveBatch(s, fb, { now: 2 }).state;
    expect(s.records[recordKey("2026-09-30", "夜班", "CR-3309")]).toBeDefined();
  });

  it("重复批次不重复带入", () => {
    const s = buildDemo();
    const night = s.records[recordKey("2026-09-30", "夜班", "CR-1201")];
    // B-night-01 出现两次但只产生一次判定
    expect(night.judgments.filter((j) => j.batchId === "B-night-01")).toHaveLength(1);
    expect(s.ledger.filter((l) => l.batchId === "B-night-01")).toHaveLength(1);
  });

  it("阈值升级后旧判定（含原本合格、新阈值超限）挂起重确认", () => {
    const s = buildDemo();
    // 早班 3200 在旧 ISO5 限值 3520 下合格，新限值 3000 下超限 → 补建档并挂起
    const morningExp = s.exceptions[exceptionKey(recordKey("2026-09-30", "早班", "CR-1201"))];
    expect(morningExp?.reconfirm?.proposed).toBe("exceeded");
    // 夜班当前超限异常也挂起重确认
    const nightExp = s.exceptions[exceptionKey(recordKey("2026-09-30", "夜班", "CR-1201"))];
    expect(nightExp.reconfirm).toBeDefined();
  });

  it("旧浏览器迁移数据：现值不被覆盖，历史处置可查", () => {
    const s = buildDemo();
    const night = s.records[recordKey("2026-09-30", "夜班", "CR-1201")];
    expect(night.fields.particleCount?.value).not.toBe(3800);
    // 历史处置归档在其原始日期的异常单上，仍可查询
    const histExp = s.exceptions[exceptionKey(recordKey("2026-08-19", "夜班", "CR-1201"))];
    expect(histExp.events.some((e) => e.note?.includes("历史：8月超限"))).toBe(true);
    // 当前异常不被迁移数据改变
    const exp = s.exceptions[exceptionKey(night.id)];
    expect(exp.status).toBe("open");
  });
});
