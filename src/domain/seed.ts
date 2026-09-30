// 初始阈值与演示批次（覆盖交接班并发、整批失败重试、已处置重开、阈值升级、旧浏览器迁移）
import { SyncBatch, ThresholdVersion } from "./types";

export const THRESHOLDS: ThresholdVersion[] = [
  {
    version: "v2024-01",
    effectiveAt: Date.parse("2024-01-01T00:00:00Z"),
    note: "初版洁净度限值",
    limits: {
      "ISO 5": 3520,
      "ISO 6": 35200,
      "ISO 7": 352000,
      黄光区: 352000,
    },
  },
  {
    version: "v2026-03",
    effectiveAt: Date.parse("2026-03-01T00:00:00Z"),
    note: "制程收紧，ISO 5/6 与黄光区限值下调",
    limits: {
      "ISO 5": 3000,
      "ISO 6": 30000,
      "ISO 7": 352000,
      黄光区: 300000,
    },
  },
];

export const DATE = "2026-09-30";

/**
 * 场景时间线（preparedAt 为离线终端现场封包时间，数组顺序即回网接收顺序）：
 *  01:10 夜班 终端A 建 CR-1201(夜班)：粒子 4100 超限 → 异常打开
 *  05:30 夜班 终端A 巡检 CR-3309（这批首次回网写入失败，留在队列单独重试）
 *  06:40 夜班 终端A 复测粒子 4800（异常仍开，复测事件）
 *  06:50 夜班 终端A 写处理备注（交接说明）
 *  07:05 早班 终端B 补录同一 CR-1201/夜班：设备状态(不同字段，直接合并)
 *       + 处理备注(与夜班同字段、都基于 r1) → 待确认列两版
 *  07:30 厂务在在线看板处置关闭：更换高效过滤器（store.runDemo 中插入）
 *  07:40 终端C 补传 06:50 的粒子 5000（已同步到 r2，封包早于处置）→ 守卫拦截不回退
 *  09:10 早班 终端B 复测 4600（处置之后的新计数）→ 异常重开、处置保留
 *  08:30 早班 终端B CR-1201/早班 粒子 3200（旧阈值合格），阈值收紧后需重确认
 *  12:00 旧浏览器导出数据补齐班次/阈值版本后迁移 → 历史处置可查、现值不动
 * 另含 CR-2107/Y-0302 稳定房间与重复批次去重。
 */
/** 07:30 在线处置之前回网的批次（night-01/02/03 + morning-01） */
export function demoBatchesBeforeResolve(): SyncBatch[] {
  return demoBatches().slice(0, 4);
}

/** 07:30 在线处置之后回网的批次（晚到旧批次 late-01、重开复测、早班/中班、重复批次） */
export function demoBatchesAfterResolve(): SyncBatch[] {
  return demoBatches().slice(4);
}

export function demoBatches(): SyncBatch[] {
  const nightCR1201 = { date: DATE, shift: "夜班" as const, roomId: "CR-1201" };
  return [
    {
      batchId: "B-night-01",
      terminal: "离线终端A",
      operator: "王夜班",
      shift: "夜班",
      thresholdVersion: "v2024-01",
      preparedAt: Date.parse("2026-09-30T01:10:00Z"),
      ops: [
        {
          kind: "record-write",
          ...nightCR1201,
          roomClass: "ISO 5",
          baseRevision: 0,
          baseFieldRevisions: {},
          fields: {
            particleCount: 4100,
            temperature: 22.1,
            humidity: 45,
            pressureDiff: 12,
            equipmentStatus: "FFU 正常",
          },
        },
      ],
    },
    {
      batchId: "B-night-02",
      terminal: "离线终端A",
      operator: "王夜班",
      shift: "夜班",
      thresholdVersion: "v2024-01",
      preparedAt: Date.parse("2026-09-30T06:40:00Z"),
      ops: [
        {
          kind: "record-write",
          ...nightCR1201,
          baseRevision: 1,
          baseFieldRevisions: { particleCount: 1 },
          fields: { particleCount: 4800 },
        },
      ],
    },
    {
      batchId: "B-night-03",
      terminal: "离线终端A",
      operator: "王夜班",
      shift: "夜班",
      thresholdVersion: "v2024-01",
      preparedAt: Date.parse("2026-09-30T06:50:00Z"),
      ops: [
        {
          kind: "record-write",
          ...nightCR1201,
          baseRevision: 2,
          baseFieldRevisions: { handlingNote: 0 },
          fields: { handlingNote: "夜班：已换高效过滤器，复测趋势待早班观察" },
        },
      ],
    },
    {
      batchId: "B-morning-01",
      terminal: "离线终端B",
      operator: "李早班",
      shift: "夜班",
      thresholdVersion: "v2024-01",
      preparedAt: Date.parse("2026-09-30T07:05:00Z"),
      ops: [
        {
          kind: "record-write",
          ...nightCR1201,
          baseRevision: 1, // 终端B 封包时只见过首版
          baseFieldRevisions: { equipmentStatus: 1 },
          fields: {
            // 不同字段：直接并入，保留早班来源
            equipmentStatus: "FFU 正常；门封条松动已紧固",
            // 同字段并发：与 B-night-03 都基于 r1(空缺) 改备注 → 待确认
            handlingNote: "早班补录：门封条松动致粒子偏高，已紧固并复测",
          },
        },
      ],
    },
    {
      // 晚到的旧批次：终端C 在 06:50 已同步到 r2 并复测封包，但 07:40 才回网，
      // 期间异常已在 07:30 在线处置 —— 字段正常更新为 5000，但已处置状态不得回退（守卫拦截）
      batchId: "B-late-01",
      terminal: "离线终端C",
      operator: "陈巡检",
      shift: "夜班",
      thresholdVersion: "v2024-01",
      preparedAt: Date.parse("2026-09-30T06:50:00Z"),
      ops: [
        {
          kind: "record-write",
          ...nightCR1201,
          baseRevision: 2,
          baseFieldRevisions: { particleCount: 2 },
          fields: { particleCount: 5000 },
        },
      ],
    },
    {
      // 早班复测：处置之后的新计数再次超限 → 重新打开，原处置保留
      batchId: "B-morning-02",
      terminal: "离线终端B",
      operator: "李早班",
      shift: "夜班",
      thresholdVersion: "v2024-01",
      preparedAt: Date.parse("2026-09-30T09:10:00Z"),
      ops: [
        {
          kind: "record-write",
          ...nightCR1201,
          baseRevision: 4,
          baseFieldRevisions: { particleCount: 3 },
          fields: { particleCount: 4600 },
        },
      ],
    },
    {
      batchId: "B-morning-03",
      terminal: "离线终端B",
      operator: "李早班",
      shift: "早班",
      thresholdVersion: "v2024-01",
      preparedAt: Date.parse("2026-09-30T08:30:00Z"),
      ops: [
        {
          kind: "record-write",
          date: DATE,
          shift: "早班",
          roomId: "CR-1201",
          roomClass: "ISO 5",
          baseRevision: 0,
          baseFieldRevisions: {},
          fields: { particleCount: 3200, humidity: 47, equipmentStatus: "运行正常" },
        },
      ],
    },
    {
      batchId: "B-mid-01",
      terminal: "离线终端C",
      operator: "赵中班",
      shift: "中班",
      thresholdVersion: "v2024-01",
      preparedAt: Date.parse("2026-09-30T15:00:00Z"),
      ops: [
        {
          kind: "record-write",
          date: DATE,
          shift: "中班",
          roomId: "CR-2107",
          roomClass: "ISO 6",
          baseRevision: 0,
          baseFieldRevisions: {},
          fields: { particleCount: 21000, humidity: 51, equipmentStatus: "正常" },
        },
        {
          kind: "record-write",
          date: DATE,
          shift: "中班",
          roomId: "Y-0302",
          roomClass: "黄光区",
          baseRevision: 0,
          baseFieldRevisions: {},
          fields: { particleCount: 120000, humidity: 58, handlingNote: "湿度接近上限，持续观察" },
        },
      ],
    },
    // 重复批次：与 B-night-01 完全相同，再回网一次必须被去重
    {
      batchId: "B-night-01",
      terminal: "离线终端A",
      operator: "王夜班",
      shift: "夜班",
      thresholdVersion: "v2024-01",
      preparedAt: Date.parse("2026-09-30T01:10:00Z"),
      ops: [
        {
          kind: "record-write",
          ...nightCR1201,
          roomClass: "ISO 5",
          baseRevision: 0,
          baseFieldRevisions: {},
          fields: {
            particleCount: 4100,
            temperature: 22.1,
            humidity: 45,
            pressureDiff: 12,
            equipmentStatus: "FFU 正常",
          },
        },
      ],
    },
  ];
}

/** 首次回网写入失败、需单独重试的一批（CR-3309 独立房间，失败时整批不落库） */
export function failingBatch(): SyncBatch {
  return {
    batchId: "B-retry-01",
    terminal: "离线终端A",
    operator: "王夜班",
    shift: "夜班",
    thresholdVersion: "v2024-01",
    preparedAt: Date.parse("2026-09-30T05:30:00Z"),
    ops: [
      {
        kind: "record-write",
        date: DATE,
        shift: "夜班",
        roomId: "CR-3309",
        roomClass: "ISO 7",
        baseRevision: 0,
        baseFieldRevisions: {},
        fields: { particleCount: 88000, temperature: 23.4, equipmentStatus: "正常" },
      },
    ],
  };
}

/** 旧浏览器（无班次/阈值版本字段）导出的补录数据，迁移时补齐 */
export function legacyBatch(): SyncBatch {
  return {
    batchId: "B-legacy-01",
    terminal: "旧浏览器导出",
    operator: "历史导入",
    shift: "夜班", // 补上班次
    thresholdVersion: "v2024-01", // 补上阈值版本
    preparedAt: Date.parse("2026-08-19T03:00:00Z"),
    legacy: true,
    ops: [
      {
        kind: "record-write",
        date: "2026-08-19",
        shift: "夜班",
        roomId: "CR-1201",
        roomClass: "ISO 5",
        baseRevision: 0,
        baseFieldRevisions: {},
        fields: { particleCount: 3800 },
      },
      {
        kind: "exception-action",
        date: "2026-08-19",
        shift: "夜班",
        roomId: "CR-1201",
        action: "resolve",
        note: "历史：8月超限后更换初效过滤器",
        thresholdVersion: "v2024-01",
      },
    ],
  };
}
