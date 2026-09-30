// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, beforeEach } from "vitest";
import App from "./App";

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
});

function flush() {
  return act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function buttonByText(re: RegExp): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((b) =>
    re.test(b.textContent ?? "")
  ) as HTMLButtonElement | undefined;
}

describe("App 渲染冒烟", () => {
  it("挂载后展示指标、记录、批次台账，并可走通接入→冲突→阈值升级流程", async () => {
    const root = createRoot(document.getElementById("root")!);
    await act(async () => {
      root.render(<App />);
    });

    expect(document.body.textContent).toContain("两班交接合并");
    // 种子：CR-1201 已处置 + 旧机迁移 CR-2107
    expect(document.body.textContent).toContain("已处置");
    expect(document.body.textContent).toContain("旧机迁移");
    expect(document.body.textContent).toContain("Y-0302 黄光区（回网超时，可重试）");

    // 失败批次可单独重试
    const retry = buttonByText(/单独重试该批/);
    expect(retry).toBeTruthy();
    await act(async () => retry!.click());
    await flush();
    expect(document.body.textContent).toContain("重试成功");

    // 逐个接入演示批次
    for (let i = 0; i < 5; i++) {
      const next = buttonByText(/^接入下一批/);
      if (!next || next.disabled) break;
      await act(async () => next.click());
      await flush();
    }
    // 出现待确认冲突（CR-1201 备注/湿度、CR-2107 计数/备注）
    expect(document.body.textContent).toContain("字段待确认");
    expect(document.body.textContent).toContain("采用晚班版本");

    // 重放已接收批次 -> 去重
    const dup = buttonByText(/重放已接收批次/);
    await act(async () => dup!.click());
    await flush();
    expect(document.body.textContent).toContain("拒绝重复带入");

    // 阈值升级 v2
    const v2 = buttonByText(/发布 v2/);
    expect(v2).toBeTruthy();
    await act(async () => v2!.click());
    await flush();
    expect(document.body.textContent).toContain("v2 已生效");
    // 旧机迁移的已处置异常因仍超限自动重开，原处置仍可见
    expect(document.body.textContent).toContain("阈值已升级至 v2");
  });
});
