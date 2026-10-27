import { expect, it } from "vitest";
import { fixture, workspace } from "./fixtures";

it("ignores delegated subagents when projecting workspace activity", async () => {
  const test = fixture();
  test.inventory.workspaces.push(
    workspace("w", "Workspace", ["task:in-progress"]),
  );
  test.inventory.agents.push(
    {
      id: "parent",
      workspaceId: "w",
      title: "Parent",
      updatedAt: "2026-09-23T00:00:00Z",
      lastUserMessageAt: null,
      archivedAt: null,
      activity: "idle",
    },
    {
      id: "child",
      workspaceId: "w",
      title: "Delegated",
      updatedAt: "2026-09-23T01:00:00Z",
      lastUserMessageAt: null,
      archivedAt: null,
      activity: "attention",
      delegatedBy: "parent",
    },
  );
  try {
    await test.board.start();
    expect(test.board.snapshot().cards[0].activity).toBe("idle");
  } finally {
    test.board.dispose();
  }
});
