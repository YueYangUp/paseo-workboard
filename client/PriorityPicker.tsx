import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  DEFAULT_PRIORITY_STYLES,
  PRIORITIES,
  type Priority,
  type PriorityStyles,
} from "../shared/model";
import { groupColorValue } from "./colors";
import type { strings } from "./strings";

export function PriorityBadge({
  value,
  priorityStyles,
  theme,
  t,
}: {
  value: Priority;
  priorityStyles?: PriorityStyles;
  theme: PluginSurfaceProps["theme"];
  t: ReturnType<typeof strings>;
}) {
  const style = (priorityStyles ?? DEFAULT_PRIORITY_STYLES)[value];
  const color = groupColorValue(style.color, theme);
  return (
    <View
      style={{
        alignSelf: "flex-start",
        maxWidth: "100%",
        flexShrink: 1,
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 5,
        borderWidth: 1,
        borderColor: `${color}50`,
        backgroundColor: `${color}14`,
      }}
    >
      <Icon name="Flag" size={13} color={color} />
      <Text
        numberOfLines={1}
        style={{ color, fontSize: 12, fontWeight: "600", flexShrink: 1 }}
      >
        {style.name ?? t.priorities[value]}
      </Text>
    </View>
  );
}

export function PriorityPicker({
  title,
  value = "normal",
  priorityStyles,
  onChange,
  disabled,
  theme,
  t,
}: {
  title: string;
  value?: Priority;
  priorityStyles?: PriorityStyles;
  onChange?(priority: Priority): Promise<boolean>;
  disabled: boolean;
  theme: PluginSurfaceProps["theme"];
  t: ReturnType<typeof strings>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const label =
    (priorityStyles ?? DEFAULT_PRIORITY_STYLES)[value].name ??
    t.priorities[value];
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t.priority}: ${title} · ${label}`}
        disabled={disabled || !onChange}
        onPress={() => setOpen(true)}
        style={{
          minHeight: 36,
          maxWidth: 112,
          alignSelf: "flex-start",
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingVertical: 4,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <PriorityBadge
          value={value}
          priorityStyles={priorityStyles}
          theme={theme}
          t={t}
        />
      </Pressable>
      <Modal
        open={open}
        title={`${t.priority} · ${title}`}
        onOpenChange={(next) => {
          if (!saving) setOpen(next);
        }}
      >
        <Modal.Content>
          <View style={{ gap: 4 }}>
            {PRIORITIES.map((priority) => (
              <Pressable
                key={priority}
                accessibilityRole="button"
                accessibilityLabel={
                  (priorityStyles ?? DEFAULT_PRIORITY_STYLES)[priority].name ??
                  t.priorities[priority]
                }
                accessibilityState={{ selected: priority === value }}
                disabled={disabled || saving}
                onPress={async () => {
                  if (priority === value) {
                    setOpen(false);
                    return;
                  }
                  if (!onChange || saving) return;
                  setSaving(true);
                  try {
                    if (await onChange(priority)) setOpen(false);
                  } finally {
                    setSaving(false);
                  }
                }}
                style={{
                  minHeight: 40,
                  padding: 10,
                  borderRadius: 6,
                  backgroundColor:
                    priority === value
                      ? theme.colors.surface2
                      : theme.colors.surface0,
                }}
              >
                <PriorityBadge
                  value={priority}
                  priorityStyles={priorityStyles}
                  theme={theme}
                  t={t}
                />
              </Pressable>
            ))}
          </View>
        </Modal.Content>
      </Modal>
    </>
  );
}
