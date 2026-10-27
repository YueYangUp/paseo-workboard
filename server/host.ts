import { isActiveActivity } from "../shared/model";
import type {
  Board,
  Card,
  ConversationAgent,
  ConversationDisplay,
  ConversationGate,
  ConversationReason,
  StartInput,
} from "../shared/model";
import type { ConversationWindow, TimelineReader } from "./conversations";
import { readConversationTime } from "./conversations";
import { checkGitSafety } from "./git-safety";
import type { PaseoApi, PaseoCompat } from "./paseo-compat";

type PaseoWorkspace = Awaited<
  ReturnType<PaseoApi["workspaces"]["list"]>
>["entries"][number];
type PaseoAgent = Awaited<
  ReturnType<PaseoApi["agents"]["list"]>
>["entries"][number]["agent"];
type EventSubscription = ReturnType<PaseoApi["observeEvents"]>;
type Observer = Parameters<EventSubscription["subscribe"]>[0];
type SessionOutboundMessage = Parameters<Observer["update"]>[0];
type Subscription = {
  release(): Promise<void>;
  subscribe(
    observer: Omit<Observer, "snapshot"> & { snapshot(): void },
  ): unknown;
};
export type ProviderChild = Awaited<
  ReturnType<PaseoCompat["subagents"]>
>[number];
interface ChildRecord {
  parentUpdatedAt: string;
  seenWhileLive: boolean;
  children: ProviderChild[];
  refused: boolean;
  retryAt?: number;
}

export type Workspace = Pick<
  PaseoWorkspace,
  | "id"
  | "name"
  | "pinnedAt"
  | "projectId"
  | "projectDisplayName"
  | "workspaceDirectory"
  | "projectKind"
  | "workspaceKind"
  | "archivingAt"
  | "status"
  | "scripts"
  | "gitRuntime"
  | "githubRuntime"
  | "forge"
  | "syncSeq"
> & { labels: string[] };
export type Agent = Pick<
  PaseoAgent,
  | "id"
  | "workspaceId"
  | "title"
  | "updatedAt"
  | "lastUserMessageAt"
  | "archivedAt"
> &
  Partial<Pick<PaseoAgent, "status" | "lastError" | "attentionReason">> & {
    activity: Card["activity"];
    parentAgentId?: string;
    delegatedBy?: string;
    subagentId?: string;
    /**
     * Whether this parent's provider children could be listed in this inventory. `skipped`
     * means the parent is idle and listing was left out on purpose: Paseo loads an agent before
     * answering a per-agent request, so a refresh must not resume it. Unlike `unavailable`, it
     * is never retried, and only the archive recheck lists such a parent.
     */
    childEnumeration?: "complete" | "refused" | "unavailable" | "skipped";
    /** A provider child of an idle, unarchived parent; reading it would load that parent. */
    parentIdle?: boolean;
  };
/**
 * One agent's conversation evidence. Display and gate stay separate because Paseo records
 * neither a trustworthy exact time nor a single usable bound for every provider.
 */
export interface ConversationEvidence {
  displayAt: string | null;
  display: ConversationDisplay;
  gateAt: string | null;
  gate: ConversationGate;
  reason: ConversationReason | null;
}
export interface Inventory {
  workspaces: Workspace[];
  agents: Agent[];
  projects: Board["projects"];
}
export interface Host {
  identity: { serverId: string; version: string };
  inventory(): Promise<Inventory>;
  workspace(id: string): Promise<Workspace | null>;
  conversation(
    agent: Agent,
    now: number,
    options?: { recheck?: boolean },
  ): Promise<ConversationEvidence>;
  /**
   * Archive recheck only: list the provider children of every idle parent among `agents`
   * (this loads that parent) and return the agents with those children filled in. Rejects
   * when a listing fails or is overtaken by an invalidation, so a caller never trusts a
   * partial or stale inventory.
   */
  recheckAgents(agents: readonly Agent[]): Promise<Agent[]>;
  setLabel(
    workspaceId: string,
    name: string,
    color: string,
    assigned: boolean,
  ): Promise<string[]>;
  setPinned(workspaceId: string, pinned: boolean): Promise<string | null>;
  create(
    source: Extract<StartInput["target"], { kind: "new" }>["source"],
    title: string,
    key: string,
  ): Promise<string>;
  safety(workspace: Workspace): Promise<string | null>;
  archive(
    id: string,
  ): Promise<{ archivedAt: string | null; error: string | null }>;
  dispose(): void;
}
interface Page<T> {
  entries: T[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}
export async function allPages<T>(
  read: (cursor?: string) => Promise<Page<T>>,
): Promise<T[]> {
  const result: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    result.push(...page.entries);
    if (!page.pageInfo.hasMore) return result;
    const next = page.pageInfo.nextCursor;
    if (!next || seen.has(next))
      throw new Error("Paseo directory pagination is incomplete");
    seen.add(next);
    cursor = next;
  } while (true);
}
function activity(agent: PaseoAgent): Card["activity"] {
  if (agent.archivedAt) return "idle";
  if (agent.pendingPermissions.length || agent.attentionReason === "permission")
    return "waiting";
  if (
    agent.status === "running" ||
    agent.status === "initializing" ||
    agent.activeTurn
  )
    return "running";
  if (
    agent.status === "error" ||
    agent.lastError ||
    agent.attentionReason === "error"
  )
    return "error";
  return agent.requiresAttention ? "attention" : "idle";
}
const isActiveAgent = (agent: Pick<Agent, "activity">) =>
  isActiveActivity(agent.activity);
const normalize = (workspace: PaseoWorkspace): Workspace => ({
  ...workspace,
  labels: workspace.labels ?? [],
});

/** Caught by the archive recheck, which defers; it never reaches a user. */
class ChildInventoryChanged extends Error {}

export class PaseoHost implements Host {
  private subscriptions: Array<() => Promise<void>> = [];
  private disposed = false;
  private subscriptionsFailed = false;
  private workspaceUpdates = new Map<string, Workspace | null>();
  private agentUpdates = new Map<string, Agent | null>();
  private agentWorkspaces = new Map<string, string | undefined>();
  /** Provider children per parent, keyed by the parent activity Paseo last reported. */
  private childRecords = new Map<string, ChildRecord>();
  private childRevision = 0;
  constructor(
    private api: PaseoApi,
    private compat: PaseoCompat,
    readonly identity: Host["identity"],
    private changed: (workspaceId?: string, agentsChanged?: boolean) => void,
  ) {}
  private own(subscription: Subscription): void {
    let initial = true;
    subscription.subscribe({
      snapshot: () => {
        if (initial) initial = false;
        else {
          this.invalidateChildren();
          this.changed(undefined, true);
        }
      },
      update: (message) => this.update(message),
      error: () => {
        this.invalidateChildren();
        this.subscriptionsFailed = true;
        this.changed(undefined, true);
      },
    });
    this.subscriptions.push(() => subscription.release());
  }
  private invalidateChildren(parentId?: string): void {
    this.childRevision++;
    for (const [id, record] of this.childRecords) {
      if (parentId !== undefined && id !== parentId) continue;
      // Retain observed children until a fresh listing succeeds.
      record.refused = true;
      record.retryAt = undefined;
    }
  }
  private update(message: SessionOutboundMessage): void {
    if (message.type === "workspace_update") {
      const change = message.payload;
      const id = change.kind === "upsert" ? change.workspace.id : change.id;
      this.workspaceUpdates.set(
        id,
        change.kind === "upsert" ? normalize(change.workspace) : null,
      );
      this.changed(id);
    } else if (message.type === "agent_update") {
      const change = message.payload;
      if (change.kind === "upsert") {
        const previousWorkspace = this.agentWorkspaces.get(change.agent.id);
        if (previousWorkspace && previousWorkspace !== change.agent.workspaceId)
          this.changed(previousWorkspace, true);
        this.agentWorkspaces.set(change.agent.id, change.agent.workspaceId);
        this.agentUpdates.set(change.agent.id, {
          ...change.agent,
          activity: activity(change.agent),
          delegatedBy: change.agent.labels?.["paseo.parent-agent-id"],
        });
        this.changed(change.agent.workspaceId, true);
      } else {
        this.invalidateChildren(change.agentId);
        this.childRecords.delete(change.agentId);
        this.agentUpdates.set(change.agentId, null);
        const workspaceId = this.agentWorkspaces.get(change.agentId);
        this.agentWorkspaces.delete(change.agentId);
        this.changed(workspaceId, true);
      }
    } else if (message.type === "agent.provider_subagents.update") {
      const change = message.payload;
      const parentAgentId =
        change.kind === "upsert"
          ? change.subagent.parentAgentId
          : change.parentAgentId;
      // A child change does not have to touch the parent, so the cache cannot wait for
      // the parent's updatedAt to move.
      this.invalidateChildren(parentAgentId);
      this.changed(this.agentWorkspaces.get(parentAgentId), true);
    }
  }
  async inventory(): Promise<Inventory> {
    if (this.disposed) throw new Error("Workboard stopped");
    this.workspaceUpdates.clear();
    this.agentUpdates.clear();
    if (this.subscriptionsFailed) {
      await Promise.allSettled(this.subscriptions.map((release) => release()));
      this.subscriptions = [];
      this.subscriptionsFailed = false;
    }
    if (!this.subscriptions.length) {
      try {
        // Host subscriptions are filtered, not paged (session.ts handleFetch*).
        // A single unfiltered subscription covers updates beyond the first 200 rows.
        this.own(
          (
            await this.api.workspaces.list({
              page: { limit: 200 },
              subscribe: {},
            })
          ).subscription,
        );
        this.own(
          (
            await this.api.agents.list({
              filter: { includeArchived: true },
              page: { limit: 200 },
              subscribe: {},
            })
          ).subscription,
        );
        const events = this.api.observeEvents([
          "agent.provider_subagents.update",
        ]);
        this.own(events);
        await events.ready;
      } catch (error) {
        await Promise.allSettled(
          this.subscriptions.map((release) => release()),
        );
        this.subscriptions = [];
        throw error;
      }
    }
    const revision = this.childRevision;
    const [workspaces, agents, projects] = await Promise.all([
      allPages((cursor) =>
        this.api.workspaces.list({ page: { limit: 200, cursor } }),
      ),
      allPages((cursor) =>
        this.api.agents.list({
          filter: { includeArchived: true },
          page: { limit: 200, cursor },
        }),
      ),
      this.api.projects.list(),
    ]);
    if (this.disposed) throw new Error("Workboard stopped");
    const workspaceMap = new Map(workspaces.map((w) => [w.id, normalize(w)]));
    const agentMap = new Map<string, Agent>(
      agents.map(({ agent }) => [
        agent.id,
        {
          ...agent,
          activity: activity(agent),
          delegatedBy: agent.labels?.["paseo.parent-agent-id"],
        },
      ]),
    );
    for (const [id, value] of this.workspaceUpdates) {
      if (!value) workspaceMap.delete(id);
      else if (
        (value.syncSeq ?? Infinity) >= (workspaceMap.get(id)?.syncSeq ?? 0)
      )
        workspaceMap.set(id, value);
    }
    for (const [id, value] of this.agentUpdates) {
      if (!value) agentMap.delete(id);
      else if (
        !agentMap.has(id) ||
        Date.parse(value.updatedAt) >= Date.parse(agentMap.get(id)!.updatedAt)
      )
        agentMap.set(id, value);
    }
    for (const agent of [...agentMap.values()]) {
      this.agentWorkspaces.set(agent.id, agent.workspaceId);
      if (!agent.workspaceId || !workspaceMap.has(agent.workspaceId)) continue;
      const record = await this.childRecord(agent);
      const idle = !agent.archivedAt && !isActiveAgent(agent);
      agent.childEnumeration = idle
        ? "skipped"
        : record.refused
          ? agent.archivedAt
            ? "refused"
            : "unavailable"
          : "complete";
      for (const child of record.children) {
        const entry = this.childAgent(agent, child, idle);
        agentMap.set(entry.id, entry);
      }
    }
    // An event during a later listing can also invalidate an earlier parent's result.
    if (revision !== this.childRevision)
      for (const agent of agentMap.values())
        if (agent.childEnumeration && agent.childEnumeration !== "skipped")
          agent.childEnumeration = agent.archivedAt ? "refused" : "unavailable";
    return {
      workspaces: [...workspaceMap.values()],
      agents: [...agentMap.values()],
      projects: projects.projects.map((project) => ({
        id: project.projectId,
        name: project.projectDisplayName,
        directory: project.projectRootPath,
        isGit: project.projectKind === "git",
      })),
    };
  }
  /**
   * Provider children are cached per parent activity. A failed live listing is retried
   * after one refresh interval; archived parents cannot be re-listed at all.
   */
  private async childRecord(agent: Agent): Promise<ChildRecord> {
    const cached = this.childRecords.get(agent.id);
    // Listing an idle parent's children would load it, so a refresh keeps what it has.
    if (!agent.archivedAt && !isActiveAgent(agent))
      return (
        cached ?? {
          parentUpdatedAt: agent.updatedAt,
          seenWhileLive: false,
          children: [],
          refused: true,
        }
      );
    if (
      cached &&
      cached.parentUpdatedAt === agent.updatedAt &&
      (agent.archivedAt
        ? cached.refused
        : !cached.refused || Date.now() < (cached.retryAt ?? 0))
    )
      return cached;
    const revision = this.childRevision;
    let record: ChildRecord;
    if (agent.archivedAt) {
      record = {
        parentUpdatedAt: agent.updatedAt,
        seenWhileLive: false,
        children: cached?.children ?? [],
        refused: true,
      };
    } else {
      try {
        record = {
          parentUpdatedAt: agent.updatedAt,
          seenWhileLive: true,
          children: await this.compat.subagents(agent.id),
          refused: false,
        };
      } catch {
        record = {
          parentUpdatedAt: agent.updatedAt,
          seenWhileLive: false,
          children: cached?.children ?? [],
          refused: true,
          retryAt: Date.now() + 60_000,
        };
      }
    }
    // An old in-flight response is neither a complete inventory nor a reusable cache.
    if (revision !== this.childRevision) return { ...record, refused: true };
    this.childRecords.set(agent.id, record);
    return record;
  }
  async recheckAgents(agents: readonly Agent[]): Promise<Agent[]> {
    if (this.disposed) throw new Error("Workboard stopped");
    const result: Agent[] = [];
    for (const agent of agents) {
      if (agent.parentAgentId) continue;
      const children = agents.filter((a) => a.parentAgentId === agent.id);
      if (agent.archivedAt || isActiveAgent(agent)) {
        result.push(agent, ...children);
        continue;
      }
      const revision = this.childRevision;
      const listed = await this.compat.subagents(agent.id);
      // An event during the listing makes it an unreliable inventory, like a refresh's.
      if (revision !== this.childRevision || this.disposed)
        throw new ChildInventoryChanged();
      const record: ChildRecord = {
        parentUpdatedAt: agent.updatedAt,
        seenWhileLive: true,
        children: listed,
        refused: false,
      };
      this.childRecords.set(agent.id, record);
      result.push(
        { ...agent, childEnumeration: "complete" },
        ...listed.map((child) => this.childAgent(agent, child, false)),
      );
    }
    return result;
  }
  private childAgent(
    parent: Agent,
    child: ProviderChild,
    idle: boolean,
  ): Agent {
    return {
      id: `${parent.id}/provider/${child.id}`,
      workspaceId: parent.workspaceId,
      parentAgentId: parent.id,
      subagentId: child.id,
      ...(idle ? { parentIdle: true } : {}),
      title: child.title,
      updatedAt: child.updatedAt,
      lastUserMessageAt: null,
      activity:
        child.status === "running"
          ? "running"
          : child.status === "failed"
            ? "error"
            : "idle",
    };
  }
  async workspace(id: string): Promise<Workspace | null> {
    const value = await this.api.workspaces.ref(id).refresh();
    return value ? normalize(value) : null;
  }
  /**
   * Read one agent's conversation evidence. `recheck` is opt-in. Paseo loads an agent before
   * it answers any per-agent request, so a refresh reads active agents only: an idle agent, an
   * archived one and a child of an idle parent answer from recorded bounds. An archived history
   * is also re-projected on every read (7.2-19.3s for pi). Only the archive recheck reads them.
   */
  async conversation(
    agent: Agent,
    now: number,
    options: { recheck?: boolean } = {},
  ): Promise<ConversationEvidence> {
    const isChild = Boolean(agent.parentAgentId && agent.subagentId);
    const parse = (value: string | null | undefined): number | null => {
      if (!value) return null;
      const time = Date.parse(value);
      return Number.isFinite(time) ? time : null;
    };
    // A recorded user message is a lower bound of the last message. A provider child's
    // descriptor timestamp is a hydration stamp, so only its parent bounds that window.
    const recordedLower = parse(agent.lastUserMessageAt);
    const recordedUpper = isChild ? null : parse(agent.updatedAt);
    const evidenceFor = (
      lower: number | null,
      reason: ConversationReason | null,
    ): ConversationEvidence => {
      // The gate is a max of upper bounds, so folding a lower bound in can only delay it.
      const gate = (value: number | null) => {
        if (value === null)
          return { gateAt: null, gate: "unknown" as ConversationGate };
        const bound = lower === null ? value : Math.max(value, lower);
        return {
          gateAt: new Date(bound).toISOString(),
          gate: "upper-bound" as ConversationGate,
        };
      };
      if (lower !== null)
        return {
          displayAt: new Date(lower).toISOString(),
          display: "lower-bound",
          ...gate(recordedUpper),
          reason,
        };
      if (recordedUpper !== null)
        return {
          displayAt: new Date(recordedUpper).toISOString(),
          display: "upper-bound",
          ...gate(recordedUpper),
          reason,
        };
      return {
        displayAt: null,
        display: "unknown",
        gateAt: null,
        gate: "unknown",
        reason,
      };
    };
    if (agent.archivedAt && !options.recheck)
      return evidenceFor(recordedLower, null);
    if (!options.recheck && !isChild && !isActiveAgent(agent))
      return evidenceFor(recordedLower, null);
    if (!options.recheck && agent.parentIdle)
      return {
        displayAt: null,
        display: "unknown",
        gateAt: null,
        gate: "unknown",
        reason: null,
      };
    let window: ConversationWindow;
    try {
      const read = isChild
        ? this.compat.subagentTimeline(agent.parentAgentId!, agent.subagentId!)
        : (timeline: Parameters<TimelineReader>[0]) =>
            this.api.agents.ref(agent.id).timeline.refetch(timeline);
      window = await readConversationTime(read, {
        now,
        observedUpdatedAt: agent.updatedAt,
        observedUserMessageAt: agent.lastUserMessageAt ?? undefined,
      });
    } catch {
      return evidenceFor(recordedLower, "timeline-unreadable");
    }
    const admitted = parse(window.latest);
    const lower =
      admitted === null
        ? recordedLower
        : recordedLower === null
          ? admitted
          : Math.max(admitted, recordedLower);
    // An exact time needs every message row, no re-projected batch, and a timeline that
    // already contains the recorded user message; otherwise the value is only a bound.
    if (
      window.messages > 0 &&
      window.replayStamped === 0 &&
      !window.reproduced &&
      admitted !== null &&
      (recordedLower === null || admitted >= recordedLower)
    )
      return {
        displayAt: new Date(admitted).toISOString(),
        display: "exact",
        gateAt: new Date(admitted).toISOString(),
        gate: "exact",
        reason: null,
      };
    if (
      window.messages === 0 &&
      window.replayStamped === 0 &&
      !window.truncated &&
      recordedLower === null
    )
      return {
        displayAt: null,
        display: "none",
        gateAt: null,
        gate: "unknown",
        reason: null,
      };
    return evidenceFor(
      lower,
      window.truncated
        ? "truncated-window"
        : recordedLower !== null &&
            admitted !== null &&
            recordedLower > admitted
          ? "timeline-unreadable"
          : "replay-timestamp",
    );
  }
  setLabel(id: string, name: string, color: string, assigned: boolean) {
    return this.compat.setLabel(id, name, color, assigned);
  }
  setPinned(id: string, pinned: boolean) {
    return this.compat.setPinned(id, pinned);
  }
  async create(
    source: Extract<StartInput["target"], { kind: "new" }>["source"],
    title: string,
    key: string,
  ) {
    return (
      await this.api.workspaces.create({ source, title, idempotencyKey: key })
    ).id;
  }
  async safety(workspace: Workspace): Promise<string | null> {
    if (workspace.scripts.some((script) => script.lifecycle === "running"))
      return "script-running";
    if (
      (await this.api.terminals.list({ workspaceId: workspace.id })).entries
        .length
    )
      return "terminal-open";
    if (
      workspace.workspaceKind === "worktree" &&
      workspace.gitRuntime?.isPaseoOwnedWorktree !== true
    )
      return "git-unknown";
    return checkGitSafety(
      workspace.workspaceDirectory,
      workspace.projectKind === "git",
    );
  }
  archive(id: string) {
    return this.api.workspaces.archive(id);
  }
  dispose() {
    this.disposed = true;
    void Promise.allSettled(this.subscriptions.map((release) => release()));
    this.subscriptions = [];
  }
}
