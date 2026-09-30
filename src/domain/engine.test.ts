import { describe, expect, it } from "vitest";
import {
  createDomainState,
  receiveBatch,
  resolveConflict,
  resolveException,
  upgradeThreshold,
  reconfirmException,
} from "./engine";
import { recordKey, FieldKey, SyncBatch, ThresholdVersion } from "./types";
import { THRESHOLDS, DATE } from "./seed";

const t = (s: string) => Date.parse(`2026-09-30T${s}Z`);

function state() {
  return createDomainState(THRESHOLDS, "v2024-01", t("00:00:00"));
}

let seq = 0;
function batch(partial: Partial<SyncBatch> & { ops: SyncBatch["ops"] }): SyncBatch {
  seq += 1;
  return {
    batchId: `T${seq}`,
    terminal: "终端X",
    operator: "操作员",
    shift: "夜班",
    thresholdVersion: "v2024-01",
    preparedAt: t("01:00:00"),
    ...partial,
  };
}

const writeCR1201 = (
  fields: Partial<Record<FieldKey, string | number>>,
  over: Partial<Extract<SyncBatch["ops"][number], { kind: "record-write" }>> = {}
): SyncBatch["ops"][number] => ({
  kind: "record-write",
  date: DATE,
  shift: "夜班",
  roomId: "CR-1201",
  roomClass: "ISO 5",
  baseRevision: 0,
  baseFieldRevisions: {},
  fields,
  ...over,
});

describe("字段级合并：同一房间同一班次只留一条，不同字段各自保留来源", () => {
  it("两班补录合并为一条记录，字段各自带来源", () => {
    let s = state();
    const r1 = receiveBatch(s, batch({
      batchId: "A1", terminal: "终端A", operator: "夜班员", shift: "夜班",
      preparedAt: t("01:00:00"),
      ops: [writeCR1201({ particleCount: 4100, temperature: 22 })],
    }), { now: t("07:00:00") });
    s = r1.state;
    const r2 = receiveBatch(s, batch({
      batchId: "B1", terminal: "终端B", operator: "早班员", shift: "夜班",
      preparedAt: t("07:05:00"),
      ops: [writeCR1201({ humidity: 45, handlingNote: "早班备注" }, { baseRevision: 1, baseFieldRevisions: {} })],
    }), { now: t("07:10:00") });
    s = r2.state;

    expect(Object.keys(s.records)).toHaveLength(1);
    const rec = s.records[recordKey(DATE, "夜班", "CR-1201")];
    expect(rec.fields.particleCount?.value).toBe(4100);
    expect(rec.fields.particleCount?.source.terminal).toBe("终端A");
    expect(rec.fields.temperature?.source.operator).toBe("夜班员");
    expect(rec.fields.humidity?.value).toBe(45);
    expect(rec.fields.humidity?.source.terminal).toBe("终端B");
    expect(rec.fields.handlingNote?.source.operator).toBe("早班员");
    // 夜班的粒子计数没有被早班批次冲掉
    expect(rec.fields.particleCount?.source.batchId).toBe("A1");
  });
});

describe("同一字段两班都改过：停在待确认并列出两版", () => {
  it("基于同一旧版并发修改 handlingNote 产生待确认冲突，两版都保留", () => {
    let s = state();
    s = receiveBatch(s, batch({
      batchId: "A1", preparedAt: t("01:00:00"),
      ops: [writeCR1201({ handlingNote: "初版备注", particleCount: 100 })],
    }), { now: t("07:00:00") }).state;
    s = receiveBatch(s, batch({
      batchId: "A2", terminal: "终端A", operator: "夜班员", preparedAt: t("06:50:00"),
      ops: [writeCR1201({ handlingNote: "夜班改的备注" }, {
        baseRevision: 1,
        baseFieldRevisions: { handlingNote: 1 },
      })],
    }), { now: t("07:01:00") }).state;
    const r = receiveBatch(s, batch({
      batchId: "B1", terminal: "终端B", operator: "早班员", preparedAt: t("07:05:00"),
      ops: [writeCR1201({ handlingNote: "早班改的备注" }, {
        baseRevision: 1,
        baseFieldRevisions: { handlingNote: 1 },
      })],
    }), { now: t("07:10:00") });
    s = r.state;

    expect(r.result.outcome).toBe("accepted");
    const rec = s.records[recordKey(DATE, "夜班", "CR-1201")];
    const conflict = rec.conflicts.find((c) => c.field === "handlingNote");
    expect(conflict?.status).toBe("pending");
    expect(conflict?.versions).toHaveLength(2);
    expect(conflict?.versions.map((v) => String(v.value)).sort()).toEqual(
      ["夜班改的备注", "早班改的备注"].sort()
    );
    // 待确认期间当前值不被任一方静默覆盖
    expect(rec.fields.handlingNote?.value).toBe("夜班改的备注");
  });

  it("人工选定一版后冲突关闭，后续基于新版本的写入正常", () => {
    let s = state();
    s = receiveBatch(s, batch({ batchId: "A1", ops: [writeCR1201({ handlingNote: "v0", particleCount: 100 })] }), { now: t("07:00:00") }).state;
    s = receiveBatch(s, batch({ batchId: "A2", preparedAt: t("06:50:00"), ops: [writeCR1201({ handlingNote: "夜班" }, { baseFieldRevisions: { handlingNote: 1 } })] }), { now: t("07:01:00") }).state;
    s = receiveBatch(s, batch({ batchId: "B1", terminal: "终端B", preparedAt: t("07:05:00"), ops: [writeCR1201({ handlingNote: "早班" }, { baseFieldRevisions: { handlingNote: 1 } })] }), { now: t("07:10:00") }).state;
    const recId = recordKey(DATE, "夜班", "CR-1201");
    s = resolveConflict(s, recId, s.records[recId].conflicts[0].id, "B1", "班组长", t("09:00:00"));
    const rec = s.records[recId];
    expect(rec.fields.handlingNote?.value).toBe("早班");
    expect(rec.conflicts[0].status).toBe("resolved");
    expect(rec.conflicts[0].resolvedBy).toBe("班组长");
  });

  it("基于最新版本的后写覆盖不产生冲突（不同字段独立）", () => {
    let s = state();
    s = receiveBatch(s, batch({ batchId: "A1", ops: [writeCR1201({ particleCount: 100, handlingNote: "a" })] }), { now: t("07:00:00") }).state;
    const r = receiveBatch(s, batch({
      batchId: "B1", preparedAt: t("08:00:00"),
      ops: [writeCR1201({ handlingNote: "b" }, { baseFieldRevisions: { handlingNote: 1 } })],
    }), { now: t("08:10:00") });
    expect(r.result.conflictIds).toHaveLength(0);
    const rec = r.state.records[recordKey(DATE, "夜班", "CR-1201")];
    expect(rec.fields.handlingNote?.value).toBe("b");
    expect(rec.fields.particleCount?.value).toBe(100);
  });
});

describe("异常联动", () => {
  function seedExceeded(s: ReturnType<typeof state>, now: number) {
    return receiveBatch(s, batch({
      batchId: `OPEN-${now}`, preparedAt: t("01:00:00"),
      ops: [writeCR1201({ particleCount: 4100 }, {
        // 若已存在合格记录，本批基于其字段版本做正常更新
        baseRevision: 1,
        baseFieldRevisions: { particleCount: 1 },
      })],
    }), { now }).state;
  }

  it("粒子超阈值自动打开异常，合格不产生异常", () => {
    let s = state();
    s = receiveBatch(s, batch({ batchId: "OK", ops: [writeCR1201({ particleCount: 100 })] }), { now: t("07:00:00") }).state;
    expect(Object.values(s.exceptions)).toHaveLength(0);
    s = seedExceeded(s, t("07:00:00"));
    const recId = recordKey(DATE, "夜班", "CR-1201");
    expect(s.exceptions[`exp#${recId}`]?.status).toBe("open");
  });

  it("已处置异常不能被旧批次改回待处理（现场时间早于处置）", () => {
    let s = state();
    s = seedExceeded(s, t("07:00:00"));
    const recId = recordKey(DATE, "夜班", "CR-1201");
    s = resolveException(s, recId, "更换过滤器", "厂务工程师", "v2024-01", t("07:30:00"));
    expect(s.exceptions[`exp#${recId}`].status).toBe("resolved");

    // 离线终端补传：封包于 05:00（处置之前），回网于 09:00
    const r = receiveBatch(s, batch({
      batchId: "STALE", preparedAt: t("05:00:00"),
      ops: [writeCR1201({ particleCount: 5000 }, { baseRevision: 1, baseFieldRevisions: { particleCount: 1 } })],
    }), { now: t("09:00:00") });
    s = r.state;
    expect(s.exceptions[`exp#${recId}`].status).toBe("resolved");
    // 旧批次的事实仍登记在时间线
    expect(s.exceptions[`exp#${recId}`].events.some((e) => e.note?.includes("守卫拦截"))).toBe(true);
  });

  it("新粒子计数再次超阈值重新打开，原有处置保留", () => {
    let s = state();
    s = seedExceeded(s, t("07:00:00"));
    const recId = recordKey(DATE, "夜班", "CR-1201");
    s = resolveException(s, recId, "更换过滤器，已处置", "厂务工程师", "v2024-01", t("07:30:00"));
    const r = receiveBatch(s, batch({
      batchId: "NEW", preparedAt: t("08:30:00"),
      ops: [writeCR1201({ particleCount: 5200 }, { baseRevision: 1, baseFieldRevisions: { particleCount: 1 } })],
    }), { now: t("08:40:00") });
    s = r.state;
    const exp = s.exceptions[`exp#${recId}`];
    expect(exp.status).toBe("open");
    expect(exp.events.some((e) => e.type === "reopened")).toBe(true);
    // 原有处置仍在时间线
    expect(exp.events.some((e) => e.type === "resolved" && e.note === "更换过滤器，已处置")).toBe(true);
  });

  it("新计数合格时不会重新打开", () => {
    let s = state();
    s = seedExceeded(s, t("07:00:00"));
    const recId = recordKey(DATE, "夜班", "CR-1201");
    s = resolveException(s, recId, "已处置", "厂务", "v2024-01", t("07:30:00"));
    s = receiveBatch(s, batch({
      batchId: "NEW2", preparedAt: t("08:30:00"),
      ops: [writeCR1201({ particleCount: 1200 }, { baseRevision: 1, baseFieldRevisions: { particleCount: 1 } })],
    }), { now: t("08:40:00") }).state;
    expect(s.exceptions[`exp#${recId}`].status).toBe("resolved");
  });

  it("粒子计数处于冲突待确认时，异常不联动；确认后联动", () => {
    let s = state();
    s = receiveBatch(s, batch({ batchId: "A1", preparedAt: t("01:00:00"), ops: [writeCR1201({ particleCount: 4100 })] }), { now: t("07:00:00") }).state;
    // 两班都基于 r1：先到的 A2 成为 r2 并复测；B1 基于 r1 → 冲突待确认
    s = receiveBatch(s, batch({ batchId: "A2", preparedAt: t("06:50:00"), ops: [writeCR1201({ particleCount: 4300 }, { baseFieldRevisions: { particleCount: 1 } })] }), { now: t("07:01:00") }).state;
    const rechecksBefore = s.exceptions[`exp#${recordKey(DATE, "夜班", "CR-1201")}`].events.filter((e) => e.type === "recheck").length;
    const r = receiveBatch(s, batch({
      batchId: "B1", terminal: "终端B", preparedAt: t("07:05:00"),
      ops: [writeCR1201({ particleCount: 900 }, { baseFieldRevisions: { particleCount: 1 } })],
    }), { now: t("07:10:00") });
    s = r.state;
    const recId = recordKey(DATE, "夜班", "CR-1201");
    const exp = s.exceptions[`exp#${recId}`];
    expect(exp.status).toBe("open");
    // 冲突期间不新增判定事件
    expect(exp.events.filter((e) => e.type === "recheck")).toHaveLength(rechecksBefore);
    const conflict = s.records[recId].conflicts.find((c) => c.field === "particleCount")!;
    s = resolveConflict(s, recId, conflict.id, "B1", "班组长", t("09:00:00"));
    // 确认合格值后追加合格复测
    expect(s.exceptions[`exp#${recId}`].events.some((e) => e.note?.includes("合格"))).toBe(true);
  });
});

describe("批次台账", () => {
  it("已接收批次重复回网不重复带入", () => {
    let s = state();
    const b = batch({ batchId: "DUP", ops: [writeCR1201({ particleCount: 100 })] });
    s = receiveBatch(s, b, { now: t("07:00:00") }).state;
    const again = receiveBatch(s, b, { now: t("08:00:00") });
    expect(again.result.outcome).toBe("duplicate");
    expect(again.state.ledger.filter((e) => e.batchId === "DUP")).toHaveLength(1);
    const rec = again.state.records[recordKey(DATE, "夜班", "CR-1201")];
    expect(rec.judgments).toHaveLength(1);
  });

  it("写入失败整批回滚、登记 failed，可用同一批次单独重试成功", () => {
    let s = state();
    const b = batch({ batchId: "FAIL", ops: [writeCR1201({ particleCount: 100 })] });
    const boom = receiveBatch(s, b, { now: t("07:00:00"), persist: () => { throw new Error("磁盘满"); } });
    expect(boom.result.outcome).toBe("failed");
    expect(boom.state.ledger[0].outcome).toBe("failed");
    // 数据没落库
    expect(Object.keys(boom.state.records)).toHaveLength(0);

    const retry = receiveBatch(boom.state, b, { now: t("07:30:00") });
    expect(retry.result.outcome).toBe("accepted");
    expect(Object.keys(retry.state.records)).toHaveLength(1);
    // 台账保留失败与成功两条轨迹
    expect(retry.state.ledger.filter((e) => e.batchId === "FAIL").map((e) => e.outcome)).toEqual(["accepted", "failed"]);
  });

  it("校验失败（未知阈值版本）登记 failed 且不接收", () => {
    const s = state();
    const r = receiveBatch(s, batch({ batchId: "BAD", thresholdVersion: "v9999", ops: [writeCR1201({ particleCount: 1 })] }), { now: t("07:00:00") });
    expect(r.result.outcome).toBe("failed");
    expect(Object.keys(r.state.records)).toHaveLength(0);
  });
});

describe("阈值版本", () => {
  const v3: ThresholdVersion = {
    version: "v2027-01",
    effectiveAt: t("10:00:00"),
    note: "更严",
    limits: { "ISO 5": 1000, "ISO 6": 10000, "ISO 7": 100000, 黄光区: 100000 },
  };

  it("版本升级后旧判定挂起待重新确认，并给出按新阈值的建议", () => {
    let s = state();
    s = receiveBatch(s, batch({ batchId: "J1", ops: [writeCR1201({ particleCount: 2500 })] }), { now: t("07:00:00") }).state;
    const recId = recordKey(DATE, "夜班", "CR-1201");
    expect(s.exceptions[`exp#${recId}`]).toBeUndefined(); // 2500 <= 3520 合格
    s = upgradeThreshold(s, v3, t("10:00:00"));
    const exp = s.exceptions[`exp#${recId}`];
    expect(exp?.reconfirm).toBeDefined();
    expect(exp?.reconfirm?.proposed).toBe("exceeded"); // 2500 > 新上限 1000
    expect(s.records[recId].judgments[0].reconfirm?.status).toBe("pending");
  });

  it("人工重新确认后挂起解除；确认仍超限则重开并保留原处置", () => {
    let s = state();
    s = receiveBatch(s, batch({ batchId: "J1", ops: [writeCR1201({ particleCount: 2500 })] }), { now: t("07:00:00") }).state;
    const recId = recordKey(DATE, "夜班", "CR-1201");
    s = receiveBatch(s, batch({
      batchId: "J0",
      preparedAt: t("07:10:00"),
      ops: [{
        kind: "exception-action", date: DATE, shift: "夜班", roomId: "CR-1201",
        action: "resolve", note: "历史处置留档", thresholdVersion: "v2024-01",
      }],
    }), { now: t("07:20:00") }).state;
    s = upgradeThreshold(s, v3, t("10:00:00"));
    s = reconfirmException(s, recId, true, "班组长", t("10:30:00"));
    const exp = s.exceptions[`exp#${recId}`];
    expect(exp.reconfirm).toBeUndefined();
    expect(exp.status).toBe("open");
    expect(exp.events.some((e) => e.type === "resolved" && e.note?.startsWith("历史处置留档"))).toBe(true);
    expect(exp.events.some((e) => e.type === "reopened")).toBe(true);
  });

  it("新版本下新计数到达，自动解除挂起的重新确认", () => {
    let s = state();
    s = receiveBatch(s, batch({ batchId: "J1", thresholdVersion: "v2024-01", ops: [writeCR1201({ particleCount: 2500 })] }), { now: t("07:00:00") }).state;
    s = upgradeThreshold(s, v3, t("10:00:00"));
    const recId = recordKey(DATE, "夜班", "CR-1201");
    s = receiveBatch(s, batch({
      batchId: "J2", thresholdVersion: "v2027-01", preparedAt: t("11:00:00"),
      ops: [writeCR1201({ particleCount: 800 }, { baseRevision: 1, baseFieldRevisions: { particleCount: 1 } })],
    }), { now: t("11:05:00") }).state;
    expect(s.exceptions[`exp#${recId}`]?.reconfirm).toBeUndefined();
  });
});

describe("旧浏览器数据迁移（补上班次与阈值版本）", () => {
  it("历史处置可查；历史值不覆盖新值；历史数据不把异常改回待处理", () => {
    let s = state();
    s = receiveBatch(s, batch({ batchId: "CUR", preparedAt: t("01:00:00"), ops: [writeCR1201({ particleCount: 4100, handlingNote: "当前备注" })] }), { now: t("07:00:00") }).state;
    const recId = recordKey(DATE, "夜班", "CR-1201");
    s = resolveException(s, recId, "当前已处置", "厂务", "v2024-01", t("07:30:00"));

    const legacy: SyncBatch = {
      batchId: "LEG",
      terminal: "旧浏览器",
      operator: "导入",
      shift: "夜班",
      thresholdVersion: "v2024-01",
      preparedAt: Date.parse("2026-08-19T03:00:00Z"),
      legacy: true,
      ops: [
        { kind: "record-write", date: DATE, shift: "夜班", roomId: "CR-1201", baseRevision: 0, baseFieldRevisions: {}, fields: { particleCount: 9999, handlingNote: "旧备注" } },
        { kind: "exception-action", date: DATE, shift: "夜班", roomId: "CR-1201", action: "resolve", note: "历史处置内容", thresholdVersion: "v2024-01" },
      ],
    };
    s = receiveBatch(s, legacy, { now: t("12:00:00") }).state;
    const rec = s.records[recId];
    expect(rec.fields.particleCount?.value).toBe(4100);
    expect(rec.fields.handlingNote?.value).toBe("当前备注");
    const exp = s.exceptions[`exp#${recId}`];
    expect(exp.status).toBe("resolved");
    expect(exp.events.some((e) => e.note?.includes("历史处置内容"))).toBe(true);
    expect(exp.events.some((e) => e.note?.includes("当前已处置"))).toBe(true);
  });
});
