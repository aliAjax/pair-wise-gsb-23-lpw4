import {
  applyBatch,
  createInitialState,
  migrateLegacy,
} from "./engine";
import type { Batch, MergeState, ThresholdVersion } from "./types";

export const DEMO_DATE = "2026-09-30";
const h = (hour: number, minute = 0) =>
  Date.UTC(2026, 8, 30, hour, minute, 0, 0);

/** 阈值 v2：ISO 5 加严到 3000，其他等级同步收紧 */
export const THRESHOLD_V2: ThresholdVersion = {
  version: 2,
  label: "v2 加严限值（工艺升级）",
  activatedAt: h(20),
  limits: {
    "ISO 5": 3000,
    "ISO 6": 30000,
    "ISO 7": 300000,
    黄光区: 300000,
  },
};

/** 交接两班离线补录的演示批次队列（按回网接入顺序排列） */
export const DEMO_BATCHES: Batch[] = [
  {
    id: "B2-晚班-CR1201",
    label: "晚班补录：CR-1201 处理备注（与早班不同字段，各自保留来源）",
    team: "晚班",
    createdAt: h(8, 30),
    items: [
      {
        roomId: "CR-1201",
        shift: "早班",
        date: DEMO_DATE,
        team: "晚班",
        editedAt: h(8, 20),
        thresholdVersion: 1,
        fields: {
          handlingNote: "晚班核对：0.5um粒子仍偏高，已加测一次",
          humidity: "43",
        },
      },
    ],
  },
  {
    id: "B6-早班-CR1201-迟到旧批次",
    label: "迟到旧批次：CR-1201 早班旧计数（不得改回待处理）",
    team: "早班",
    createdAt: h(10, 20),
    items: [
      {
        roomId: "CR-1201",
        shift: "早班",
        date: DEMO_DATE,
        team: "早班",
        editedAt: h(6, 10),
        thresholdVersion: 1,
        fields: { particleCount: "6000" },
      },
    ],
  },
  {
    id: "B4-早班-CR1201-复测",
    label: "早班新批次复测：CR-1201 新计数再次超限→重开（保留原处置）",
    team: "早班",
    createdAt: h(11, 10),
    items: [
      {
        roomId: "CR-1201",
        shift: "早班",
        date: DEMO_DATE,
        team: "早班",
        editedAt: h(11, 5),
        thresholdVersion: 1,
        fields: { particleCount: "4200" },
      },
    ],
  },
  {
    id: "B5-晚班-CR2107",
    label: "晚班首报：CR-2107 粒子超限",
    team: "晚班",
    createdAt: h(9, 0),
    items: [
      {
        roomId: "CR-2107",
        shift: "晚班",
        date: DEMO_DATE,
        team: "晚班",
        editedAt: h(8, 50),
        thresholdVersion: 1,
        isoClass: "ISO 6",
        fields: {
          particleCount: "41000",
          temperature: "22.1",
          pressureDiff: "15",
          handlingNote: "回风异常，已通知厂务",
        },
      },
    ],
  },
  {
    id: "B7-早班-CR2107-冲突",
    label: "早班对晚班记录有异议：CR-2107 计数两版→待确认",
    team: "早班",
    createdAt: h(10, 40),
    items: [
      {
        roomId: "CR-2107",
        shift: "晚班",
        date: DEMO_DATE,
        team: "早班",
        editedAt: h(10, 30),
        thresholdVersion: 1,
        fields: { particleCount: "48000", handlingNote: "早班复测：48000，判定超限" },
      },
    ],
  },
];

/** 模拟回网写入失败、可单独重试的批次 */
export const FAILED_BATCH: Batch = {
  id: "B8-晚班-Y0302-失败",
  label: "晚班补录：Y-0302 黄光区（回网超时，可重试）",
  team: "晚班",
  createdAt: h(9, 20),
  items: [
    {
      roomId: "Y-0302",
      shift: "晚班",
      date: DEMO_DATE,
      team: "晚班",
      editedAt: h(9, 10),
      thresholdVersion: 1,
      isoClass: "黄光区",
      fields: {
        particleCount: "210000",
        humidity: "52",
        handlingNote: "湿度接近上限，持续观察",
      },
    },
  ],
};

/** 已接收批次的重放：应被去重 */
export const DUPLICATE_BATCH: Batch = {
  ...DEMO_BATCHES[0],
  createdAt: h(13, 0),
};

/**
 * 预置看板初始状态：
 *  - CR-1201 早班：早班超限→已处置关闭（换新FFU，复测2800）
 *  - CR-2107 2026-08-15 早班：旧浏览器迁移来的已处置异常（历史处置保留）
 */
export function buildSeedState(): MergeState {
  let state = createInitialState();

  // 旧浏览器数据（无班次/无阈值版本），迁移时补上
  state = migrateLegacy(state, [
    {
      roomId: "CR-2107",
      capturedAt: Date.UTC(2026, 7, 20, 2, 30),
      date: "2026-08-20",
      shift: "早班",
      thresholdVersion: 1,
      fields: {
        isoClass: "ISO 5",
        particleCount: "4000",
        temperature: "21.8",
        handlingNote: "旧终端补录：粒子偏高",
      },
      pastDisposition: {
        note: "风淋室联锁修复后复测合格",
        disposedAt: Date.UTC(2026, 7, 20, 5, 0),
      },
    },
  ]).state;

  state = applyBatch(state, {
    id: "B1-早班-CR1201",
    label: "早班首报：CR-1201 粒子超限",
    team: "早班",
    createdAt: h(7, 0),
    items: [
      {
        roomId: "CR-1201",
        shift: "早班",
        date: DEMO_DATE,
        team: "早班",
        editedAt: h(6, 30),
        thresholdVersion: 1,
        isoClass: "ISO 5",
        fields: {
          particleCount: "5000",
          temperature: "21.5",
          humidity: "44",
          pressureDiff: "12",
          equipmentStatus: "FFU运行",
          handlingNote: "0.5um粒子超限，已通知厂务",
        },
      },
    ],
  }).state;

  state = applyBatch(state, {
    id: "B3-早班-CR1201-处置",
    label: "早班处置：CR-1201 更换FFU并复测",
    team: "早班",
    createdAt: h(10, 0),
    items: [
      {
        roomId: "CR-1201",
        shift: "早班",
        date: DEMO_DATE,
        team: "早班",
        editedAt: h(9, 40),
        thresholdVersion: 1,
        fields: { particleCount: "2800", equipmentStatus: "FFU已更换" },
        resolution: { disposition: "更换FFU过滤器，复测2800合格" },
      },
    ],
  }).state;

  // B8 模拟一次写入失败
  state = applyBatch(state, FAILED_BATCH, {
    simulateError: "回网超时（网关504）",
  }).state;

  return state;
}

/** 旧浏览器待迁移示例（迁移面板默认填充） */
export const LEGACY_SAMPLE = [
  {
    roomId: "Y-0302",
    capturedAtText: "2026-09-12 03:20",
    date: "2026-09-12",
    shift: "夜班" as const,
    thresholdVersion: 1,
    fields: {
      isoClass: "黄光区",
      particleCount: "380000",
      handlingNote: "旧终端：黄光区粒子超限",
    },
    pastDisposition: { note: "更换黄色防酸罩密封，复测合格", disposedAtText: "2026-09-12 06:00" },
  },
];
