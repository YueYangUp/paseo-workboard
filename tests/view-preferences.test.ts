import { describe, expect, it, vi } from "vitest";
vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
import {
  loadViewPreferences,
  loadViewPreferencesFrom,
  saveViewPreferences,
  saveViewPreferencesTo,
} from "../client/view-preferences";

describe("view preferences", () => {
  it("remembers a host's view and list folds without changing board preferences", () => {
    const values = new Map<string, string>([
      ["paseo-workboard:collapsed-columns:a", '["done"]'],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(loadViewPreferencesFrom(storage, "a")).toEqual({
      mode: "board",
      collapsedListGroups: [],
      priorityFirst: true,
    });
    expect(
      saveViewPreferencesTo(storage, "a", {
        mode: "list",
        collapsedListGroups: ["todo"],
      }),
    ).toBe(true);
    expect(loadViewPreferencesFrom(storage, "a")).toEqual({
      mode: "list",
      collapsedListGroups: ["todo"],
      priorityFirst: true,
    });
    expect(loadViewPreferencesFrom(storage, "b").mode).toBe("board");
    expect(values.get("paseo-workboard:collapsed-columns:a")).toBe('["done"]');
  });

  it.each(["{bad", "null", "[]", '{"mode":"future","collapsedListGroups":7}'])(
    "falls back safely for invalid saved preferences %s",
    (value) => {
      expect(loadViewPreferencesFrom({ getItem: () => value }, "a")).toEqual({
        mode: "board",
        collapsedListGroups: [],
        priorityFirst: true,
      });
    },
  );

  it("keeps only unique valid group ids", () => {
    expect(
      loadViewPreferencesFrom(
        {
          getItem: () =>
            '{"mode":"list","collapsedListGroups":["todo","todo","",2,"done"]}',
        },
        "a",
      ),
    ).toEqual({
      mode: "list",
      collapsedListGroups: ["todo", "done"],
      priorityFirst: true,
    });
  });

  it("reports storage denial without preventing the current view from rendering", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw Error("denied");
      },
      setItem() {
        throw Error("denied");
      },
    });
    try {
      expect(loadViewPreferences("a").mode).toBe("board");
      expect(
        saveViewPreferences("a", { mode: "list", collapsedListGroups: [] }),
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it("retains an explicit disabled priority-sort preference per host", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  saveViewPreferencesTo(storage, "a", {
    mode: "board",
    collapsedListGroups: [],
    priorityFirst: false,
  });
  expect(loadViewPreferencesFrom(storage, "a").priorityFirst).toBe(false);
  expect(loadViewPreferencesFrom(storage, "b").priorityFirst).toBe(true);
});
