import { Platform } from "react-native";

export type ViewMode = "board" | "list";
export type ViewPreferences = {
  mode: ViewMode;
  collapsedListGroups: string[];
  groupBy?: "status" | "project";
  priorityFirst?: boolean;
  collapsedProjectGroups?: string[];
};
type StorageReader = { getItem(key: string): string | null };
type StorageWriter = { setItem(key: string, value: string): void };
declare const localStorage: (StorageReader & StorageWriter) | undefined;
const storageKey = (host: string) => `paseo-workboard:view:${host}`;
const defaults = (): ViewPreferences => ({
  mode: "board",
  collapsedListGroups: [],
});

export function loadViewPreferencesFrom(
  storage: StorageReader,
  host: string,
): ViewPreferences {
  try {
    const value = JSON.parse(storage.getItem(storageKey(host)) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value))
      return defaults();
    return {
      mode: value.mode === "list" ? "list" : "board",
      ...(value.groupBy === "project" || value.groupBy === "status"
        ? { groupBy: value.groupBy }
        : {}),
      ...(typeof value.priorityFirst === "boolean"
        ? { priorityFirst: value.priorityFirst }
        : {}),
      ...(Array.isArray(value.collapsedProjectGroups)
        ? {
            collapsedProjectGroups: [
              ...new Set<string>(
                value.collapsedProjectGroups.filter(
                  (id: unknown): id is string =>
                    typeof id === "string" && id.length > 0,
                ),
              ),
            ],
          }
        : {}),
      collapsedListGroups: Array.isArray(value.collapsedListGroups)
        ? [
            ...new Set<string>(
              value.collapsedListGroups.filter(
                (id: unknown): id is string =>
                  typeof id === "string" && id.length > 0,
              ),
            ),
          ]
        : [],
    };
  } catch {
    return defaults();
  }
}

export function saveViewPreferencesTo(
  storage: StorageWriter,
  host: string,
  value: ViewPreferences,
): boolean {
  try {
    storage.setItem(storageKey(host), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadViewPreferences(host: string): ViewPreferences {
  try {
    return Platform.OS === "web" && typeof localStorage !== "undefined"
      ? loadViewPreferencesFrom(localStorage, host)
      : defaults();
  } catch {
    return defaults();
  }
}

export function saveViewPreferences(
  host: string,
  value: ViewPreferences,
): boolean {
  try {
    return (
      Platform.OS !== "web" ||
      typeof localStorage === "undefined" ||
      saveViewPreferencesTo(localStorage, host, value)
    );
  } catch {
    return false;
  }
}
