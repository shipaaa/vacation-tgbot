import { describe, expect, it } from "vitest";
import { findCategory, findNamedItem } from "../src/ai/naturalInput.js";

const accounts = [
  { id: "cash", name: "Наличные JPY" },
  { id: "card", name: "Карта CRY" },
];

describe("natural input matching", () => {
  it("сопоставляет названия без учёта регистра и символов", () => {
    expect(findNamedItem(accounts, "наличные-jpy")?.id).toBe("cash");
    expect(findNamedItem(accounts, "КАРТА CRY")?.id).toBe("card");
  });

  it("не выбирает неоднозначное совпадение", () => {
    expect(findNamedItem([
      { name: "Карта USD" },
      { name: "Карта RUB" },
    ], "карта")).toBeNull();
  });

  it("использует Другое только для неизвестной категории", () => {
    const categories = ["Питание", "Транспорт", "Другое"];
    expect(findCategory(categories, "питание")).toBe("Питание");
    expect(findCategory(categories, "музей")).toBe("Другое");
  });
});
