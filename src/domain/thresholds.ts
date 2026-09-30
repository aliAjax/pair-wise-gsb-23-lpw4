import type { ThresholdVersion } from "./types";

/**
 * 阈值按版本管理。版本一变，旧阈值下做出的判定全部 needsReconfirm。
 * 数值为 ≥0.5µm 悬浮粒子上限（个/m³，按 ISO 14644-1 量级取演示值）。
 */
export const INITIAL_THRESHOLDS: ThresholdVersion[] = [
  {
    version: 1,
    label: "v1 常规限值",
    activatedAt: Date.UTC(2026, 8, 1, 0, 0, 0),
    limits: {
      "ISO 5": 3520,
      "ISO 6": 35200,
      "ISO 7": 352000,
      黄光区: 352000,
    },
  },
];

export function getThreshold(
  thresholds: Record<number, ThresholdVersion>,
  version: number
): ThresholdVersion | null {
  return thresholds[version] ?? null;
}

/** 某等级在指定阈值版本下的粒子上限 */
export function particleLimit(
  thresholds: Record<number, ThresholdVersion>,
  version: number,
  isoClass: string
): number | null {
  const t = getThreshold(thresholds, version);
  if (!t) return null;
  return t.limits[isoClass.trim()] ?? null;
}

/** 解析粒子计数输入：允许千分位；非法返回 null */
export function parseParticleCount(raw: string): number | null {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/[,，\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function exceedsThreshold(
  thresholds: Record<number, ThresholdVersion>,
  version: number,
  isoClass: string,
  rawCount: string
): { exceeds: boolean | null; limit: number | null; count: number | null } {
  const count = parseParticleCount(rawCount);
  const limit = particleLimit(thresholds, version, isoClass);
  if (count === null || limit === null) return { exceeds: null, limit, count };
  return { exceeds: count > limit, limit, count };
}
