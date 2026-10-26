import { expect, it, vi } from "vitest";
import { dataSchema, newTask } from "../shared/model";
import { migrateData } from "../shared/migrations";
import { Store } from "../server/store";
import { Workboard } from "../server/workboard";
import { fixture, workspace } from "./fixtures";

function legacyData() {
  return migrateData({ schemaVersion: 9 }, 9);
}

it("enables exclusivity for fresh data without a pending upgrade", () => {
  const data = dataSchema.parse({});
  expect(data.settings.exclusiveStatusLabels).toBe(true);
  expect(data.exclusiveStatusLabelsPending).toBe(false);
});

it.each([false, true])(
  "decides once from live labels, preserves conflicts and survives restart (conflict: %s)",
  async (conflict) => {
    const data = legacyData();
    data.tasks = [
      {
        ...newTask("old", "Old task", "2026-09-23T00:00:00Z"),
        workspaceId: "w",
        lastStage: "todo",
        resolvedStage: "todo",
      },
    ];
    const { board, host, inventory, store, backing } = fixture(data);
    inventory.workspaces.push(workspace("clean", "Clean", ["task:todo"]));
    inventory.workspaces.push(
      workspace(
        "w",
        "Task",
        conflict
          ? ["customer", "task:todo", "task:done"]
          : ["customer", "task:todo"],
      ),
    );
    const readInventory = vi.spyOn(host, "inventory");
    const readWorkspace = vi.spyOn(host, "workspace");
    let resumed: Workboard | undefined;
    try {
      await board.start();
      expect(store.current.exclusiveStatusLabelsPending).toBe(false);
      expect(store.current.settings.exclusiveStatusLabels).toBe(!conflict);
      expect(host.setLabel).not.toHaveBeenCalled();
      expect(readInventory).toHaveBeenCalledTimes(1);
      expect(readWorkspace).not.toHaveBeenCalled();
      if (conflict) {
        expect(
          board.snapshot().cards.find((card) => card.workspaceId === "w")
            ?.stage,
        ).toBe("conflict");
        inventory.workspaces[1].labels = ["customer", "task:todo"];
      } else {
        inventory.workspaces[1].labels = ["customer", "task:todo", "task:done"];
      }
      board.dispose();
      const resumedStore = new Store(backing);
      resumed = new Workboard(host, resumedStore);
      await resumed.start();
      expect(resumedStore.current.settings.exclusiveStatusLabels).toBe(
        !conflict,
      );
      expect(resumedStore.current.exclusiveStatusLabelsPending).toBe(false);
      expect(inventory.workspaces[1].labels).toEqual(
        conflict ? ["customer", "task:todo"] : ["customer", "task:done"],
      );
    } finally {
      board.dispose();
      resumed?.dispose();
    }
  },
);

it("leaves the decision pending when inventory fails and retries on startup", async () => {
  const { board, host, inventory, store } = fixture(legacyData());
  inventory.workspaces.push(workspace("w", "Task", ["task:todo", "task:done"]));
  vi.spyOn(host, "inventory").mockRejectedValueOnce(
    new Error("Incomplete inventory"),
  );
  try {
    await expect(board.start()).rejects.toThrow("Incomplete inventory");
    expect(store.current.exclusiveStatusLabelsPending).toBe(true);
    expect(store.current.settings.exclusiveStatusLabels).toBe(false);
    expect(host.setLabel).not.toHaveBeenCalled();
    await board.start();
    expect(store.current.exclusiveStatusLabelsPending).toBe(false);
    expect(store.current.settings.exclusiveStatusLabels).toBe(false);
  } finally {
    board.dispose();
  }
});

it("does not complete the decision or edit labels when persistence fails", async () => {
  const { board, host, inventory, store, backing } = fixture(legacyData());
  inventory.workspaces.push(workspace("w", "Task", ["task:todo"]));
  const write = backing.write;
  vi.spyOn(backing, "write").mockImplementation(async (revision, values) => {
    if (!values.exclusiveStatusLabelsPending) throw new Error("Write failed");
    return write(revision, values);
  });
  try {
    await expect(board.start()).rejects.toThrow("Write failed");
    expect(store.current.exclusiveStatusLabelsPending).toBe(true);
    expect(host.setLabel).not.toHaveBeenCalled();
    vi.mocked(backing.write).mockImplementation(write);
    await board.start();
    expect(store.current.exclusiveStatusLabelsPending).toBe(false);
    expect(store.current.settings.exclusiveStatusLabels).toBe(true);
  } finally {
    board.dispose();
  }
});

it("keeps the decision pending if the connection is lost after inventory is read", async () => {
  const { board, host, inventory, store } = fixture(legacyData());
  inventory.workspaces.push(workspace("w", "Task", ["task:todo"]));
  const read = host.inventory;
  vi.spyOn(host, "inventory").mockImplementationOnce(async () => {
    const result = await read();
    board.disconnected("Connection lost");
    return result;
  });
  try {
    await expect(board.start()).rejects.toThrow("Connection lost");
    expect(store.current.exclusiveStatusLabelsPending).toBe(true);
    expect(host.setLabel).not.toHaveBeenCalled();
    await board.start();
    expect(store.current.exclusiveStatusLabelsPending).toBe(false);
    expect(store.current.settings.exclusiveStatusLabels).toBe(true);
  } finally {
    board.dispose();
  }
});

it("reloads a saved decision after its write response is lost instead of deciding again", async () => {
  const { board, host, inventory, store, backing } = fixture(legacyData());
  inventory.workspaces.push(workspace("w", "Task", ["task:todo"]));
  const write = backing.write;
  vi.spyOn(backing, "write").mockImplementation(async (revision, values) => {
    const result = await write(revision, values);
    if (!values.exclusiveStatusLabelsPending) throw new Error("Response lost");
    return result;
  });
  try {
    await expect(board.start()).rejects.toThrow("Response lost");
    expect(host.setLabel).not.toHaveBeenCalled();
    vi.mocked(backing.write).mockImplementation(write);
    inventory.workspaces[0].labels.push("task:done");
    await board.start();
    expect(store.current.exclusiveStatusLabelsPending).toBe(false);
    expect(store.current.settings.exclusiveStatusLabels).toBe(true);
    expect(inventory.workspaces[0].labels).toEqual(["task:done"]);
  } finally {
    board.dispose();
  }
});
