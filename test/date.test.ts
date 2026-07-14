import { describe, expect, it } from "vitest";
import { dateInTimezone, formatDate, parseCalendarDate } from "../src/domain/date.js";

describe("calendar dates", () => {
  it("показывает ISO-дату в формате ДД.ММ.ГГГГ", () => {
    expect(formatDate("2026-07-14")).toBe("14.07.2026");
  });

  it("сохраняет уже отформатированную дату и отклоняет невозможную", () => {
    expect(formatDate("14.07.2026")).toBe("14.07.2026");
    expect(parseCalendarDate("31.02.2026")).toBeNull();
  });

  it("учитывает часовой пояс поездки", () => {
    const date = new Date("2026-07-14T16:30:00.000Z");
    expect(dateInTimezone(date, "Asia/Tokyo")).toBe("15.07.2026");
  });
});
