import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MonitorData } from "@/lib/monitor-types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { Monitor } from "@/components/monitor";

const base: MonitorData = {
  today: "2026-10-09",
  checkedAt: "2026-10-09T01:05:00Z",
  nextScheduledAt: "2026-10-10T01:00:00Z",
  source: "local",
  todayStatus: "done",
  actions: { visit: "done", like: "done", comment: "pending" },
  progress: {
    observedAt: "2026-10-09T01:04:00Z",
    visit: { day30: 30, day90: 61 },
    like: { day30: 12, day90: null },
    comment: { day30: 5, day90: 5 },
  },
  recent: [
    { date: "2026-10-09", status: "done" },
    { date: "2026-10-08", status: "attention" },
  ],
};

const render = (data: MonitorData) => renderToStaticMarkup(createElement(Monitor, { data }));

describe("read-only activity monitor", () => {
  it("shows the three activities with 30- and 90-day progress", () => {
    const markup = render(base);
    expect(markup).toContain("<h2>Visit</h2>");
    expect(markup).toContain("<h2>Like</h2>");
    expect(markup).toContain("<h2>Comment</h2>");
    expect(markup).toContain("30 / 30");
    expect(markup).toContain("61 / 90");
    expect(markup).toContain("12 / 30");
  });

  it("renders today's status and leaves missing 90-day streaks blank", () => {
    const markup = render(base);
    expect(markup).toContain("Done today");
    expect(markup).toContain("— / 90");
  });

  it("has no operator controls or mutating form fields", () => {
    const markup = render(base);
    for (const tag of ["<form", "<input", "<select", "<textarea"]) expect(markup).not.toContain(tag);
    expect(markup).not.toMatch(/Run now|Retry|Add to queue|Save settings/);
  });

  it("degrades to a placeholder when no local data is available", () => {
    const markup = render({
      ...base, source: "unavailable", todayStatus: "unknown",
      actions: { visit: "unknown", like: "unknown", comment: "unknown" },
      progress: { observedAt: null, visit: { day30: null, day90: null }, like: { day30: null, day90: null }, comment: { day30: null, day90: null } },
      recent: [],
    });
    expect(markup).toContain("No data yet");
    expect(markup).toContain("— / 30");
    expect(markup).toContain("No runs recorded yet");
  });
});
