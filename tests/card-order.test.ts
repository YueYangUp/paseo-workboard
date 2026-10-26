import { expect, it, vi } from "vitest";
import {
  DATA_SCHEMA_VERSION,
  dataSchema,
  newTask,
  type Card,
} from "../shared/model";
import { cardsForStage } from "../client/board-utils";
import { mutationSchema } from "../shared/rpc";
import { migrateData } from "../shared/migrations";
import { Store } from "../server/store";
import { Workboard } from "../server/workboard";
import { fixture, workspace } from "./fixtures";

const ids = (cards: readonly { id: string }[]) => cards.map((card) => card.id);
const column = (test: ReturnType<typeof fixture>, stage = "todo") =>
  cardsForStage(
    test.board.snapshot().cards,
    stage,
    test.board.snapshot().cardOrderByStage,
  ) as Card[];
const reorder = (
  test: ReturnType<typeof fixture>,
  taskId: string,
  expectedOrder: string[],
  cardOrder: string[],
  stage = "todo",
) =>
  test.board.mutate(
    mutationSchema.parse({
      action: "reorder-cards",
      taskId,
      stage,
      expectedOrder,
      cardOrder,
    }),
  );
function drafts() {
  return fixture({
    tasks: [
      newTask("a", "A", "2026-09-01T00:00:00Z"),
      newTask("b", "B", "2026-09-02T00:00:00Z"),
      newTask("c", "C", "2026-09-03T00:00:00Z"),
    ],
  });
}
it("F08 persists manual order through reload, rejects stale CAS and resets activity order without touching tasks or host state", async () => {
  const test = drafts();
  await test.board.start();
  let reopened: Workboard | undefined;
  try {
    const before = test.store.current.tasks;
    expect(ids(column(test))).toEqual(["c", "b", "a"]);
    test.host.inventory = vi.fn(test.host.inventory);
    const moved = await reorder(test, "a", ["c", "b", "a"], ["a", "c", "b"]);
    expect(moved.cardOrderByStage).toEqual({ todo: ["a", "c", "b"] });
    expect(ids(column(test))).toEqual(["a", "c", "b"]);
    expect(test.store.current.tasks).toEqual(before);
    await expect(
      reorder(test, "b", ["c", "b", "a"], ["b", "c", "a"]),
    ).rejects.toThrow("card-order-changed");
    test.board.dispose();
    reopened = new Workboard(test.host, new Store(test.backing), test.now);
    await reopened.start();
    expect(
      ids(
        cardsForStage(
          reopened.snapshot().cards,
          "todo",
          reopened.snapshot().cardOrderByStage,
        ),
      ),
    ).toEqual(["a", "c", "b"]);
    vi.mocked(test.host.inventory).mockClear();
    await reopened.mutate(
      mutationSchema.parse({
        action: "reset-card-order",
        stage: "todo",
        expectedOrder: ["a", "c", "b"],
      }),
    );
    expect(reopened.snapshot().cardOrderByStage).toEqual({});
    expect(ids(cardsForStage(reopened.snapshot().cards, "todo"))).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(test.host.inventory).not.toHaveBeenCalled();
    expect(test.host.setLabel).not.toHaveBeenCalled();
    expect(test.host.setPinned).not.toHaveBeenCalled();
    expect(test.host.archive).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
    reopened?.dispose();
  }
});
it.each([
  ["duplicate", ["a", "c", "a"]],
  ["missing", ["a", "c"]],
  ["outsider", ["a", "c", "x"]],
  ["other-relative-order", ["a", "b", "c"]],
])(
  "F08 rejects %s membership/order changes atomically",
  async (_reason, order) => {
    const test = drafts();
    await test.board.start();
    try {
      const before = test.store.current;
      await expect(
        reorder(test, "a", ["c", "b", "a"], order as string[]),
      ).rejects.toThrow("card-order-invalid");
      expect(test.store.current).toEqual(before);
    } finally {
      test.board.dispose();
    }
  },
);
it("F08 compares the complete snapshot column, not stale lastStage or filtered IDs", async () => {
  const test = drafts();
  test.inventory.workspaces.push(workspace("w", "Workspace", ["task:todo"]));
  await test.board.start();
  try {
    const before = ids(column(test));
    expect(before).toHaveLength(4);
    await expect(
      reorder(test, "a", ["c", "b", "a"], ["a", "c", "b"]),
    ).rejects.toThrow("card-order-changed");
    test.inventory.workspaces[0].labels = ["task:review"];
    await test.board.refresh();
    await test.store.update((data) => {
      data.tasks.find((t) => t.workspaceId === "w")!.lastStage = "todo";
    });
    await reorder(test, "a", ["c", "b", "a"], ["a", "c", "b"]);
    expect(ids(column(test))).toEqual(["a", "c", "b"]);
  } finally {
    test.board.dispose();
  }
});
it.each(["uncertain", "pending"] as const)(
  "F08 permits a legal mover around binding and %s neighbors, but refuses those movers",
  async (status) => {
    const test = drafts();
    await test.board.start();
    try {
      await test.store.update((data) => {
        data.tasks.find((t) => t.id === "b")!.binding = {
          operationId: "binding",
          target: { kind: "existing", workspaceId: "missing" },
          workspaceId: null,
          stage: "in-progress",
        };
        data.tasks.find((t) => t.id === "c")!.archived = {
          operationId: "archive",
          status,
          kind: "automatic",
          stage: "todo",
          group: null,
          startedAt: "2026-09-01T00:00:00Z",
          archivedAt: null,
          lastConversationAt: null,
          detail: "unknown",
        };
      });
      await reorder(test, "a", ["c", "b", "a"], ["a", "c", "b"]);
      expect(ids(column(test))).toEqual(["a", "c", "b"]);
      for (const id of ["b", "c"])
        await expect(
          reorder(
            test,
            id,
            ["a", "c", "b"],
            id === "b" ? ["b", "a", "c"] : ["c", "a", "b"],
          ),
        ).rejects.toThrow("card-order-mover-unavailable");
    } finally {
      test.board.dispose();
    }
  },
);
it("F08 appends new cards, preserves returning positions, compacts at the next reorder and cleans deleted group keys", async () => {
  const test = drafts();
  await test.board.start();
  try {
    await reorder(test, "a", ["c", "b", "a"], ["a", "c", "b"]);
    await test.board.mutate({
      action: "stage",
      taskId: "c",
      stage: "canceled",
      expectedLabels: [],
    });
    expect(ids(column(test))).toEqual(["a", "b"]);
    await test.board.mutate({
      action: "stage",
      taskId: "c",
      stage: "todo",
      expectedLabels: [],
    });
    expect(ids(column(test))).toEqual(["a", "c", "b"]);
    await test.board.mutate({
      action: "create",
      title: "Newest",
      description: "",
      projectId: null,
    });
    const newest = column(test).at(-1)!.id;
    expect(ids(column(test))).toEqual(["a", "c", "b", newest]);
    await test.board.mutate({
      action: "stage",
      taskId: "c",
      stage: "canceled",
      expectedLabels: [],
    });
    await reorder(test, "b", ["a", "b", newest], ["b", "a", newest]);
    expect(test.store.current.cardOrderByStage.todo).toEqual([
      "b",
      "a",
      newest,
    ]);
    await test.store.update((data) => {
      data.cardOrderByStage.review = ["old-id"];
    });
    const settings = test.store.current.settings;
    await test.board.mutate({
      action: "settings",
      revision: test.store.current.revision,
      expectedSettings: settings,
      settings: {
        ...settings,
        groups: settings.groups.filter((g) => g.id !== "review"),
      },
    });
    expect(test.store.current.cardOrderByStage).not.toHaveProperty("review");
  } finally {
    test.board.dispose();
  }
});
it("F08 admits only one concurrent CAS and keeps the loser from overwriting", async () => {
  const test = drafts();
  await test.board.start();
  try {
    const result = await Promise.allSettled([
      reorder(test, "a", ["c", "b", "a"], ["a", "c", "b"]),
      reorder(test, "b", ["c", "b", "a"], ["b", "c", "a"]),
    ]);
    expect(result.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(ids(column(test))).toEqual(["a", "c", "b"]);
  } finally {
    test.board.dispose();
  }
});
it.each([1, 2, 3, 4, 5, 6, 7])(
  "F08 migrates v%s to the current schema with empty top-level ordering",
  (version) => {
    const result = migrateData({ schemaVersion: version }, version);
    expect(result.schemaVersion).toBe(DATA_SCHEMA_VERSION);
    expect(result.cardOrderByStage).toEqual({});
    expect(dataSchema.parse(result)).toEqual(result);
  },
);
it("F08 shared sorter preserves activity order without a key and ignores absent IDs safely", () => {
  const values = [
    { ...newTask("a", "A", "2026-09-01T00:00:00Z"), stage: "todo" },
    { ...newTask("b", "B", "2026-09-02T00:00:00Z"), stage: "todo" },
  ] as Card[];
  expect(ids(cardsForStage(values, "todo"))).toEqual(["b", "a"]);
  expect(
    ids(cardsForStage(values, "todo", { todo: ["missing", "a"] })),
  ).toEqual(["a", "b"]);
  expect(
    ids(
      cardsForStage(
        values.map((c) => ({ ...c, stage: "constructor" })),
        "constructor",
        {},
      ),
    ),
  ).toEqual(["b", "a"]);
});

it("F08 rechecks the CAS inside Store.update after a queued concurrent membership write", async () => {
  const test = drafts();
  await test.board.start();
  let release!: () => void;
  let entered!: () => void;
  let queued!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const enqueue = new Promise<void>((resolve) => {
    queued = resolve;
  });
  const write = test.backing.write;
  let first = true;
  test.backing.write = async (expected, data) => {
    if (first) {
      first = false;
      entered();
      await blocked;
    }
    return write(expected, data);
  };
  try {
    const competing = test.store.update((data) => {
      data.tasks.push(newTask("new", "New", "2026-09-04T00:00:00Z"));
    });
    await writing;
    const update = test.store.update.bind(test.store);
    test.store.update = (change) => {
      queued();
      return update(change);
    };
    const moved = reorder(test, "a", ["c", "b", "a"], ["a", "c", "b"]);
    await enqueue;
    release();
    await competing;
    await expect(moved).rejects.toThrow("card-order-changed");
    expect(ids(column(test))).toEqual(["new", "c", "b", "a"]);
    expect(test.store.current.cardOrderByStage).toEqual({});
  } finally {
    release();
    test.board.dispose();
  }
});
it("F08 ordering bound cards leaves evidence, tasks, pins and native labels unchanged", async () => {
  const test = fixture();
  for (const id of ["a", "b", "c"]) {
    test.inventory.workspaces.push(workspace(id, id, ["task:review"]));
    test.inventory.agents.push({
      id: "agent-" + id,
      workspaceId: id,
      title: null,
      activity: "idle",
      lastUserMessageAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    });
  }
  test.host.conversation = async () => ({
    displayAt: "2026-08-01T00:00:00Z",
    display: "exact",
    gateAt: "2026-08-01T00:00:00Z",
    gate: "exact",
    reason: null,
  });
  await test.board.start();
  try {
    const before = test.store.current;
    const native = structuredClone(test.inventory);
    const order = ids(column(test, "review"));
    test.host.inventory = vi.fn(test.host.inventory);
    test.host.conversation = vi.fn(test.host.conversation);
    vi.mocked(test.host.setPinned).mockClear();
    await reorder(
      test,
      order[2],
      order,
      [order[2], order[0], order[1]],
      "review",
    );
    expect(test.store.current.tasks).toEqual(before.tasks);
    expect(test.store.current.autoPins).toEqual(before.autoPins);
    expect(test.inventory).toEqual(native);
    expect(test.host.inventory).not.toHaveBeenCalled();
    expect(test.host.conversation).not.toHaveBeenCalled();
    expect(test.host.setPinned).not.toHaveBeenCalled();
    expect(test.host.setLabel).not.toHaveBeenCalled();
    expect(test.host.archive).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});
it("F08 allows independent columns to reorder without a global revision lock", async () => {
  const test = drafts();
  await test.board.start();
  try {
    await test.store.update((data) => {
      data.tasks.push(
        newTask("d", "D", "2026-09-01T00:00:00Z", "canceled"),
        newTask("e", "E", "2026-09-02T00:00:00Z", "canceled"),
      );
    });
    const result = await Promise.allSettled([
      reorder(test, "a", ["c", "b", "a"], ["a", "c", "b"]),
      reorder(test, "d", ["e", "d"], ["d", "e"], "canceled"),
    ]);
    expect(result.map((value) => value.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
  } finally {
    test.board.dispose();
  }
});
