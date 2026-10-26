import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  PROVIDER_PROTOCOL_VERSION,
  negotiateProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPersistence,
} from "@getpaseo/plugin/server/provider";

const marker = "paseo-workboard-integration-v1";
const home = process.env.PASEO_HOME;
if (!home) throw new Error("Fixture requires PASEO_HOME");
const markerPath = path.join(home, ".paseo-workboard-integration");
const storePath = path.join(home, "workboard-fixture-sessions.json");
const capabilities = [
  "prompt.message",
  "session.list",
  "session.persistence",
] as const;
const userAt = "2025-01-02T03:04:05.000Z";
const assistantAt = "2025-01-02T03:04:06.000Z";

type Stored = Record<string, { id: string; cwd: string }>;

async function assertMarker(): Promise<void> {
  if ((await readFile(markerPath, "utf8").catch(() => "")).trim() !== marker) {
    throw new Error("Fixture refuses a home without the integration marker");
  }
}
async function readStore(): Promise<Stored> {
  try {
    return JSON.parse(await readFile(storePath, "utf8")) as Stored;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return {};
    throw error;
  }
}
async function saveStore(value: Stored): Promise<void> {
  await mkdir(home!, { recursive: true });
  const temp = `${storePath}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), "utf8");
  await rename(temp, storePath);
}
const persist = (id: string): ProviderPersistence => ({
  version: 1,
  data: { fixtureSessionId: id },
});
function persistedId(
  value: ProviderPersistence | undefined,
): string | undefined {
  const data = value?.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    return undefined;
  const id = Reflect.get(data, "fixtureSessionId");
  return typeof id === "string" ? id : undefined;
}
function promptText(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
): string {
  return input.prompt.input.type === "message"
    ? input.prompt.input.content
        .filter(
          (part): part is { type: "text"; text: string } =>
            part.type === "text",
        )
        .map((part) => part.text)
        .join("\n")
    : "fixture command";
}

export default function contribute(server: PluginServerContext) {
  server.registerProvider({
    id: "workboard-fixture",
    label: "Workboard fixture",
    async connect(request) {
      await assertMarker();
      if (!request.versions.includes(PROVIDER_PROTOCOL_VERSION))
        throw new Error("Provider protocol 1 required");
      const negotiated = negotiateProviderCapabilities(
        request.capabilities,
        capabilities,
      );
      let listener: ((event: ProviderEvent) => void) | undefined;
      const emit = (event: ProviderEvent) => listener?.(event);
      const connection: ProviderConnection = {
        version: PROVIDER_PROTOCOL_VERSION,
        capabilities: negotiated,
        async send(input) {
          if (input.type === "catalog") {
            emit({
              type: "catalog",
              requestId: input.requestId,
              catalog: {
                models: [
                  { id: "fixture-model", label: "Fixture", isDefault: true },
                ],
                modes: [],
                defaultModel: "fixture-model",
              },
            });
          } else if (input.type === "sessions") {
            emit({
              type: "sessions",
              requestId: input.requestId,
              sessions: Object.values(await readStore()).map((session) => ({
                persistence: persist(session.id),
                cwd: session.cwd,
                title: "Fixture session",
                updatedAt: assistantAt,
              })),
            });
          } else if (input.type === "session.open") {
            const stored = await readStore();
            const id = persistedId(input.persistence) ?? randomUUID();
            const session = stored[id] ?? { id, cwd: input.config.cwd };
            stored[id] = session;
            await saveStore(stored);
            emit({
              type: "session.opened",
              requestId: input.requestId,
              sessionId: input.sessionId,
              capabilities: negotiated,
              restoration: "core",
              persistence: persist(id),
              cwd: session.cwd,
            });
            if (input.history === "replay") {
              emit({
                type: "timeline.item",
                sessionId: input.sessionId,
                timestamp: userAt,
                item: {
                  type: "user_message",
                  id: "fixture-history-user",
                  text: "fixture historical user",
                },
              });
              emit({
                type: "timeline.item",
                sessionId: input.sessionId,
                timestamp: assistantAt,
                item: {
                  type: "assistant_message",
                  id: "fixture-history-assistant",
                  text: "fixture historical assistant",
                },
              });
            }
            emit({
              type: "session.ready",
              requestId: input.requestId,
              sessionId: input.sessionId,
            });
          } else if (input.type === "session.prompt") {
            const turnId = `fixture-turn-${input.prompt.clientMessageId}`;
            emit({
              type: "session.prompt_result",
              sessionId: input.sessionId,
              clientMessageId: input.prompt.clientMessageId,
              result: { type: "turn", turnId },
            });
            emit({
              type: "session.turn",
              sessionId: input.sessionId,
              turnId,
              state: "started",
            });
            emit({
              type: "timeline.item",
              sessionId: input.sessionId,
              timestamp: userAt,
              item: {
                type: "user_message",
                id: `fixture-user-${input.prompt.clientMessageId}`,
                clientMessageId: input.prompt.clientMessageId,
                text: promptText(input),
              },
            });
            emit({
              type: "timeline.item",
              sessionId: input.sessionId,
              timestamp: assistantAt,
              item: {
                type: "assistant_message",
                id: `fixture-assistant-${input.prompt.clientMessageId}`,
                text: "fixture assistant",
              },
            });
            // A held turn lets integration tests observe complete live child enumeration.
            if (promptText(input) !== "fixture hold turn")
              emit({
                type: "session.turn",
                sessionId: input.sessionId,
                turnId,
                state: "completed",
              });
          } else if (input.type === "session.close") {
            emit({ type: "session.closed", sessionId: input.sessionId });
          } else if ("requestId" in input)
            emit({ type: "request.completed", requestId: input.requestId });
        },
        onEvent(next) {
          listener = next;
          return () => {
            if (listener === next) listener = undefined;
          };
        },
        async close() {
          listener = undefined;
        },
      };
      return connection;
    },
  });
  return () => {};
}
