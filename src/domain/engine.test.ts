import { describe, expect, it } from "vitest";
import {
  applyBatch,
  bumpThresholdVersion,
  createInitialState,
  mergeField,
  migrateLegacy,
  recordKeyOf,
  reconfirmRecord,
  resolveAnomaly,
  resolveConflict,
} from "./engine";
import type {
  Batch,
  BatchItem,
  FieldVersion,
  ThresholdVersion,
} from "./types";

const DATE = "2026-09-30";
const T1 = Date.UTC(2026, 8, 30, 2, 0); // 早班补录
const T2 = Date.UTC(2026, 8, 30, 3, 0);
const T3 = Date.UTC(2026, 8, 30, 4, 0);
const T4 = Date.UTC(2026, 8, 30, 5, 0);
const T5 = Date.UTC(2026, 8, 30, 6, 0);

function item(partial: Partial<BatchItem> & { team: BatchItem["team"]; editedAt: number }): BatchItem {
  return {
    roomId: "CR-1201",
    shift: "早班",
    date: DATE,
    thresholdVersion: 1,
    fields: {},
    ...partial,
  };
}

function batch(id: string, team: BatchItem["team"], items: BatchItem[], label = id): Batch {
  return { id, label, team, createdAt: T2, items };
}

function fv(value: string, team: FieldVersion["team"], at: number, batchId = "B"): FieldVersion {
  return { value, team, batchId, editedAt: at, thresholdVersion: 1 };
}

describe("字段级合并", () => {
  it("不同字段各自保留来源，同一房间同一班次只留一条记录", () => {
    let s = createInitialState();
    s = applyBatch(
      s,
      batch("B1", "早班", [
        item({
          team: "早班",
          editedAt: T1,
          isoClass: "ISO 5",
          fields: { particleCount: "5000", temperature: "21.4" },
        }),
      ])
    ).state;
    s = applyBatch(
      s,
      batch("B2", "晚班", [
        item({
          team: "晚班",
          editedAt: T2,
          fields: { handlingNote: "0.5um偏高，已记录", humidity: "45" },
        }),
      ])
    ).state;

    const key = recordKeyOf("CR-1201", DATE, "早班");
    expect(Object.keys(s.records)).toHaveLength(1);
    const r = s.records[key];
    expect(r.fields.particleCount.accepted?.value).toBe("5000");
    expect(r.fields.particleCount.accepted?.team).toBe("早班");
    expect(r.fields.handlingNote.accepted?.value).toContain("偏高");
    expect(r.fields.handlingNote.accepted?.team).toBe("晚班");
    expect(r.fields.temperature.accepted?.team).toBe("早班");
    expect(r.fields.humidity.accepted?.team).toBe("晚班");
    expect(r.revision).toBe(2);
  });

  it("同字段两班都改过且不一致 -> 待确认，列出两版，不覆盖", () => {
    const merged = mergeField(
      { accepted: fv("早班备注", "早班", T1, "B1"), candidates: [] },
      fv("晚班备注", "晚班", T2, "B2")
    );
    expect(merged.state.candidates).toHaveLength(2);
    expect(merged.state.accepted?.value).toBe("早班备注");
    expect(merged.conflictRaised).toBe(true);
  });

  it("两班同字段取值相同 -> 不冲突", () => {
    const merged = mergeField(
      { accepted: fv("正常", "早班", T1, "B1"), candidates: [] },
      fv("正常", "晚班", T2, "B2")
    );
    expect(merged.state.candidates).toHaveLength(0);
    expect(merged.state.accepted?.value).toBe("正常");
  });

  it("同班后续更新覆盖自己，同班旧值迟到不能冲掉新值", () => {
    const newer = mergeField(
      { accepted: fv("4200", "早班", T2, "B1"), candidates: [] },
      fv("4300", "早班", T3, "B4")
    );
    expect(newer.state.accepted?.value).toBe("4300");

    const stale = mergeField(
      { accepted: fv("4300", "早班", T3, "B4"), candidates: [] },
      fv("5000", "早班", T1, "B6")
    );
    expect(stale.state.accepted?.value).toBe("4300");
    expect(stale.staleIgnored).toBe(true);
  });

  it("裁决选晚班版本后冲突清除", () => {
    let s = createInitialState();
    s = applyBatch(
      s,
      batch("B1", "早班", [item({ team: "早班", editedAt: T1, fields: { handlingNote: "甲" } })])
    ).state;
    s = applyBatch(
      s,
      batch("B2", "晚班", [item({ team: "晚班", editedAt: T2, fields: { handlingNote: "乙" } })])
    ).state;
    const key = recordKeyOf("CR-1201", DATE, "早班");
    expect(s.records[key].fields.handlingNote.candidates).toHaveLength(2);
    s = resolveConflict(
      s,
      { recordKey: key, field: "handlingNote", chooseTeam: "晚班", decidedBy: "班组长", decidedAt: T5 },
      { id: "DECIDE-1" }
    );
    expect(s.records[key].fields.handlingNote.accepted?.value).toBe("乙");
    expect(s.records[key].fields.handlingNote.candidates).toHaveLength(0);
  });
});

describe("异常处理接线", () => {
  function seededResolved() {
    let s = createInitialState();
    s = applyBatch(
      s,
      batch("B1", "早班", [
        item({
          team: "早班",
          editedAt: T1,
          isoClass: "ISO 5",
          fields: { particleCount: "5000" },
        }),
      ])
    ).state;
    s = applyBatch(
      s,
      batch("B3", "早班", [
        item({
          team: "早班",
          editedAt: T3,
          // 处置同时复测合格：粒子字段更新为新值，异常关闭
          fields: { particleCount: "2800" },
          resolution: { disposition: "更换FFU过滤器并复测合格" },
        }),
      ])
    ).state;
    return s;
  }

  it("粒子超限自动开异常单（v1 ISO 5 限值 3520）", () => {
    const s = seededResolved();
    const key = recordKeyOf("CR-1201", DATE, "早班");
    const ax = s.anomalies[s.anomalyIndex[key]];
    expect(ax.status).toBe("resolved");
    expect(ax.events.map((e) => e.type)).toEqual(["open", "resolve"]);
  });

  it("已处置异常不能被旧批次改回待处理，只登记 ignored-stale", () => {
    let s = seededResolved();
    const res = applyBatch(
      s,
      batch("B6", "早班", [
        item({ team: "早班", editedAt: T2, fields: { particleCount: "6000" } }),
      ])
    );
    s = res.state;
    const key = recordKeyOf("CR-1201", DATE, "早班");
    const ax = s.anomalies[s.anomalyIndex[key]];
    expect(ax.status).toBe("resolved");
    expect(ax.events.at(-1)?.type).toBe("ignored-stale");
    // 生效粒子计数仍是处置复测后的新值，旧值未冲掉
    expect(s.records[key].fields.particleCount.accepted?.value).toBe("2800");
    expect(res.reports[0].anomaly?.action).toBe("stale-ignored");
  });

  it("新粒子计数再次超限 -> 重开并保留原处置事件", () => {
    let s = seededResolved();
    s = applyBatch(
      s,
      batch("B4", "早班", [
        item({ team: "早班", editedAt: T4, isoClass: "ISO 5", fields: { particleCount: "4200" } }),
      ])
    ).state;
    const key = recordKeyOf("CR-1201", DATE, "早班");
    const ax = s.anomalies[s.anomalyIndex[key]];
    expect(ax.status).toBe("reopened");
    const types = ax.events.map((e) => e.type);
    expect(types).toEqual(["open", "resolve", "reopen"]);
    const reopen = ax.events.find((e) => e.type === "reopen");
    expect(reopen?.detail).toContain("更换FFU过滤器");
  });

  it("不同班次是不同记录，互不影响", () => {
    let s = seededResolved();
    s = applyBatch(
      s,
      batch("B2", "晚班", [
        item({
          team: "晚班",
          shift: "晚班",
          editedAt: T1,
          isoClass: "ISO 5",
          fields: { particleCount: "1000" },
        }),
      ])
    ).state;
    expect(Object.keys(s.records)).toHaveLength(2);
    expect(s.anomalies[s.anomalyIndex[recordKeyOf("CR-1201", DATE, "晚班")]]).toBeUndefined();
  });

  it("跨班粒子冲突未裁决前不自动判定；裁决采用超限版本后重开", () => {
    let s = seededResolved();
    // 先让早班接受一个合格新值并仍保持 resolved（合格不动状态）
    s = applyBatch(
      s,
      batch("B4", "早班", [item({ team: "早班", editedAt: T4, fields: { particleCount: "3000" } })])
    ).state;
    const key = recordKeyOf("CR-1201", DATE, "早班");
    expect(s.anomalies[s.anomalyIndex[key]].status).toBe("resolved");

    const conflict = applyBatch(
      s,
      batch("B7", "晚班", [item({ team: "晚班", editedAt: T5, fields: { particleCount: "4800" } })])
    );
    s = conflict.state;
    expect(s.records[key].fields.particleCount.candidates).toHaveLength(2);
    // 冲突待确认，异常仍 resolved，未被旧/争议值改动
    expect(s.anomalies[s.anomalyIndex[key]].status).toBe("resolved");

    s = resolveConflict(
      s,
      { recordKey: key, field: "particleCount", chooseTeam: "晚班", decidedBy: "班组长", decidedAt: T5 + 1000 },
      { id: "DECIDE-2" }
    );
    const ax = s.anomalies[s.anomalyIndex[key]];
    expect(ax.status).toBe("reopened");
    expect(ax.events.map((e) => e.type)).toContain("reopen");
  });

  it("看板直接处置重开异常", () => {
    let s = seededResolved();
    s = applyBatch(
      s,
      batch("B4", "早班", [item({ team: "早班", editedAt: T4, fields: { particleCount: "4200" } })])
    ).state;
    const key = recordKeyOf("CR-1201", DATE, "早班");
    const axId = s.anomalyIndex[key];
    s = resolveAnomaly(s, axId, "再次更换过滤器，复测2800", "厂务工程师", T5);
    expect(s.anomalies[axId].status).toBe("resolved");
    expect(s.anomalies[axId].events).toHaveLength(4);
  });

  it("交接顺序：旧批次先被忽略，随后新批次重开；处置/忽略/重开事件按序保留", () => {
    let s = seededResolved();
    // 迟到的旧批次：编辑时间早于处置，只登记 ignored-stale
    const stale = applyBatch(
      s,
      batch("B6", "早班", [item({ team: "早班", editedAt: T2, fields: { particleCount: "6000" } })])
    );
    expect(stale.reports[0].anomaly?.action).toBe("stale-ignored");
    s = stale.state;
    const key = recordKeyOf("CR-1201", DATE, "早班");
    expect(s.records[key].fields.particleCount.accepted?.value).toBe("2800");
    expect(s.anomalies[s.anomalyIndex[key]].status).toBe("resolved");

    // 随后新批次再次超限：重开，原处置仍在事件链中
    s = applyBatch(
      s,
      batch("B7", "早班", [item({ team: "早班", editedAt: T4, fields: { particleCount: "4200" } })])
    ).state;
    const ax = s.anomalies[s.anomalyIndex[key]];
    expect(ax.status).toBe("reopened");
    expect(ax.events.map((e) => e.type)).toEqual([
      "open",
      "resolve",
      "ignored-stale",
      "reopen",
    ]);
  });
});

describe("批次台账：失败重试 / 去重", () => {
  it("写入失败整批不落库，可单独重试成功", () => {
    let s = createInitialState();
    const b = batch("B8", "晚班", [
      item({ team: "晚班", editedAt: T2, isoClass: "ISO 6", fields: { particleCount: "1000" } }),
    ]);
    const failed = applyBatch(s, b, { simulateError: "回网超时 504" });
    expect(failed.outcome).toBe("failed");
    expect(Object.keys(failed.state.records)).toHaveLength(0);
    expect(failed.state.failedBatches["B8"]).toBeTruthy();
    s = failed.state;

    const retry = applyBatch(s, b);
    expect(retry.outcome).toBe("replayed");
    expect(Object.keys(retry.state.records)).toHaveLength(1);
    expect(retry.state.failedBatches["B8"]).toBeUndefined();
    expect(retry.state.ledger.map((l) => l.outcome)).toEqual(["failed", "replayed"]);
  });

  it("已接收批次重复带入只记 duplicate，不二次合并", () => {
    let s = createInitialState();
    const b = batch("B1", "早班", [item({ team: "早班", editedAt: T1, fields: { handlingNote: "x" } })]);
    s = applyBatch(s, b).state;
    const replay = applyBatch(s, b);
    expect(replay.outcome).toBe("duplicate");
    const key = recordKeyOf("CR-1201", DATE, "早班");
    expect(replay.state.records[key].revision).toBe(1);
  });

  it("未知阈值版本的批次被拒绝，可修正后重试", () => {
    const s = createInitialState();
    const bad = applyBatch(
      s,
      batch("BX", "早班", [item({ team: "早班", editedAt: T1, thresholdVersion: 9, fields: { handlingNote: "1" } })])
    );
    expect(bad.outcome).toBe("failed");
    expect(bad.error).toContain("阈值版本");
  });
});

describe("阈值版本升级", () => {
  const v2: ThresholdVersion = {
    version: 2,
    label: "v2 加严限值",
    activatedAt: T5,
    limits: { "ISO 5": 3000, "ISO 6": 30000, "ISO 7": 300000, 黄光区: 300000 },
  };

  it("版本一变旧判定全部 needsReconfirm；仍超限的已处置异常重开且保留处置", () => {
    let s = createInitialState();
    s = applyBatch(
      s,
      batch("B1", "早班", [
        item({
          team: "早班",
          editedAt: T1,
          isoClass: "ISO 5",
          fields: { particleCount: "4200" },
        }),
      ])
    ).state;
    s = applyBatch(
      s,
      batch("B3", "早班", [item({ team: "早班", editedAt: T2, resolution: { disposition: "密封门修复" } })])
    ).state;
    const key = recordKeyOf("CR-1201", DATE, "早班");
    expect(s.anomalies[s.anomalyIndex[key]].status).toBe("resolved");

    const { state: next, reports } = bumpThresholdVersion(s, v2);
    expect(next.currentThresholdVersion).toBe(2);
    const ax = next.anomalies[next.anomalyIndex[key]];
    expect(ax.status).toBe("reopened");
    expect(ax.events.find((e) => e.type === "resolve")?.disposition).toBe("密封门修复");
    expect(ax.events.at(-1)?.detail).toContain("密封门修复");
    expect(reports.find((r) => r.recordKey === key)?.action).toBe("reopened");
    expect(next.records[key].needsReconfirm).toBe(false);
  });

  it("新阈值下合格的待处理异常保持打开待人工关闭", () => {
    let s = createInitialState();
    s = applyBatch(
      s,
      batch("B1", "早班", [
        item({ team: "早班", editedAt: T1, isoClass: "ISO 5", fields: { particleCount: "4200" } }),
      ])
    ).state;
    const { state: next } = bumpThresholdVersion(s, v2);
    const key = recordKeyOf("CR-1201", DATE, "早班");
    const ax = next.anomalies[next.anomalyIndex[key]];
    // 4200 在 v2 限值 3000 之上，仍超限，保持打开
    expect(ax.status).toBe("open");
  });

  it("人工复核合格可关闭", () => {
    let s = createInitialState();
    s = applyBatch(
      s,
      batch("B1", "早班", [
        item({ team: "早班", editedAt: T1, isoClass: "ISO 5", fields: { particleCount: "4200" } }),
      ])
    ).state;
    const { state: bumped } = bumpThresholdVersion(s, v2);
    const key = recordKeyOf("CR-1201", DATE, "早班");
    const next = reconfirmRecord(bumped, key, {
      stillExceeds: false,
      note: "现场复测2800，合格",
      team: "班组长",
      at: T5,
    });
    expect(next.records[key].needsReconfirm).toBe(false);
    expect(next.anomalies[next.anomalyIndex[key]].status).toBe("resolved");
  });

  it("旧阈值版本批次在新版本生效后到达，记录与异常均需重新确认", () => {
    let s = createInitialState();
    const { state: bumped } = bumpThresholdVersion(s, v2);
    const next = applyBatch(
      bumped,
      batch("B9", "晚班", [
        item({ team: "晚班", editedAt: T1, isoClass: "ISO 5", fields: { particleCount: "2500" } }),
      ])
    ).state;
    const key = recordKeyOf("CR-1201", DATE, "早班");
    expect(next.records[key].needsReconfirm).toBe(true);
  });
});

describe("旧浏览器数据迁移", () => {
  it("补上班次与阈值版本后历史处置仍可查；阈值升级时旧处置异常进入复核", () => {
    let s = createInitialState();
    const result = migrateLegacy(s, [
      {
        roomId: "CR-2107",
        capturedAt: Date.UTC(2026, 7, 15, 3, 0),
        date: "2026-08-15",
        shift: "早班",
        thresholdVersion: 1,
        fields: { isoClass: "ISO 5", particleCount: "4000", handlingNote: "旧系统补录" },
        pastDisposition: {
          note: "旧系统处置：风淋室联锁修复",
          disposedAt: Date.UTC(2026, 7, 15, 5, 0),
        },
      },
    ]);
    expect(result.outcome).toBe("accepted");
    s = result.state;
    const key = recordKeyOf("CR-2107", "2026-08-15", "早班");
    const r = s.records[key];
    expect(r.legacy).toBe(true);
    expect(r.shift).toBe("早班");
    expect(r.judgedThresholdVersion).toBe(1);
    const ax = s.anomalies[s.anomalyIndex[key]];
    expect(ax.status).toBe("resolved");
    expect(ax.events.find((e) => e.type === "resolve")?.disposition).toContain("风淋室联锁修复");
    expect(r.fields.particleCount.accepted?.legacy).toBe(true);

    // 重复迁移幂等
    const again = migrateLegacy(s, [
      {
        roomId: "CR-2107",
        capturedAt: Date.UTC(2026, 7, 15, 3, 0),
        date: "2026-08-15",
        shift: "早班",
        thresholdVersion: 1,
        fields: { isoClass: "ISO 5", particleCount: "4000" },
        pastDisposition: { note: "旧系统处置：风淋室联锁修复", disposedAt: Date.UTC(2026, 7, 15, 5, 0) },
      },
    ]);
    expect(again.outcome).toBe("duplicate");
  });
});
