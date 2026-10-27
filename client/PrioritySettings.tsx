import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import {
  SettingsCard,
  SettingsInput,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  DEFAULT_PRIORITY_STYLES,
  GROUP_COLORS,
  PRIORITIES,
  priorityStyleSchema,
  type GroupColor,
  type Priority,
  type PriorityStyles,
} from "../shared/model";
import { PriorityBadge } from "./PriorityPicker";
import { groupColorValue } from "./colors";
import type { strings } from "./strings";

type Props = {
  value?: PriorityStyles;
  onChange(value: PriorityStyles): Promise<boolean>;
  disabled: boolean;
  theme: PluginSurfaceProps["theme"];
  t: ReturnType<typeof strings>;
};

export function PrioritySettings({
  value,
  onChange,
  disabled,
  theme,
  t,
}: Props) {
  const styles = value ?? DEFAULT_PRIORITY_STYLES;
  const [editing, setEditing] = useState<{
    priority: Priority;
    styles: PriorityStyles;
    onChange: Props["onChange"];
  } | null>(null);
  return (
    <SettingsSection title={t.prioritySettings}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {t.prioritySettingsHint}
      </Text>
      <SettingsCard>
        {PRIORITIES.map((priority) => (
          <Pressable
            key={priority}
            accessibilityRole="button"
            accessibilityLabel={`${t.edit}: ${styles[priority].name ?? t.priorities[priority]}`}
            disabled={disabled}
            testID={`workboard-edit-priority-${priority}`}
            onPress={() => setEditing({ priority, styles, onChange })}
            style={{
              minHeight: 44,
              padding: 10,
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              opacity: disabled ? 0.5 : 1,
            }}
          >
            <PriorityBadge
              value={priority}
              priorityStyles={styles}
              theme={theme}
              t={t}
            />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {t.edit}
            </Text>
          </Pressable>
        ))}
      </SettingsCard>
      {editing && (
        <PriorityEditor
          priority={editing.priority}
          value={editing.styles}
          onChange={editing.onChange}
          disabled={disabled}
          theme={theme}
          t={t}
          onClose={() => setEditing(null)}
        />
      )}
    </SettingsSection>
  );
}

export function PriorityEditor({
  priority,
  value,
  onChange,
  onClose,
  disabled,
  theme,
  t,
}: Omit<Props, "value"> & {
  priority: Priority;
  value: PriorityStyles;
  onClose(): void;
}) {
  const initial = value[priority];
  const initialName = initial.name ?? t.priorities[priority];
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState<GroupColor>(initial.color);
  const [reset, setReset] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidate = {
    name:
      reset || (initial.name === null && name === initialName)
        ? null
        : name.trim(),
    color,
  };
  const valid = !!name.trim() && name.trim().length <= 24;
  const blocked = disabled || saving;
  return (
    <Modal
      open
      title={`${t.priority} · ${initialName}`}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Modal.Content>
        <SettingsCard>
          <SettingsInput
            key={inputKey}
            label={t.priorityName}
            initialValue={name}
            onChangeText={(text) => {
              setReset(false);
              setName(text);
            }}
            disabled={blocked}
            error={valid ? null : t.priorityNameInvalid}
            testID="workboard-priority-name"
          />
        </SettingsCard>
        <View style={{ gap: 10, paddingVertical: 12 }}>
          <Text style={{ color: theme.colors.foreground }}>
            {t.priorityColor}
          </Text>
          <View
            accessibilityRole="radiogroup"
            style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
          >
            {GROUP_COLORS.map((item) => {
              const tone = groupColorValue(item, theme);
              const selected = color === item;
              return (
                <Pressable
                  key={item}
                  accessibilityRole="radio"
                  accessibilityLabel={`${t.priorityColor}: ${t.groupColors[item]}`}
                  accessibilityState={{ checked: selected }}
                  aria-checked={selected}
                  disabled={blocked}
                  onPress={() => setColor(item)}
                  style={{
                    minWidth: 40,
                    minHeight: 40,
                    borderWidth: selected ? 2 : 1,
                    borderColor: selected ? tone : theme.colors.border,
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: blocked ? 0.5 : 1,
                  }}
                >
                  <View
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 10,
                      backgroundColor: tone,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {selected && (
                      <Icon
                        name="Check"
                        size={14}
                        color={theme.colors.surface0}
                      />
                    )}
                  </View>
                </Pressable>
              );
            })}
          </View>
          <PriorityBadge
            value={priority}
            priorityStyles={{ ...value, [priority]: candidate }}
            theme={theme}
            t={t}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.resetPriority}
          disabled={blocked}
          testID="workboard-reset-priority"
          style={{
            minHeight: 36,
            justifyContent: "center",
            alignSelf: "flex-start",
            opacity: blocked ? 0.5 : 1,
          }}
          onPress={() => {
            setName(t.priorities[priority]);
            setColor(DEFAULT_PRIORITY_STYLES[priority].color);
            setReset(true);
            setInputKey((key) => key + 1);
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted }}>
            {t.resetPriority}
          </Text>
        </Pressable>
        {error && (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.colors.statusDanger }}
          >
            {error}
          </Text>
        )}
        <View
          style={{
            flexDirection: "row",
            justifyContent: "flex-end",
            gap: 12,
            marginTop: 12,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.cancel}
            disabled={saving}
            onPress={onClose}
            style={{ minHeight: 36, padding: 8 }}
          >
            <Text style={{ color: theme.colors.foregroundMuted }}>
              {t.cancel}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.save}
            disabled={blocked || !valid}
            testID="workboard-save-priority"
            style={{
              minHeight: 36,
              padding: 8,
              opacity: blocked || !valid ? 0.5 : 1,
            }}
            onPress={async () => {
              if (blocked || !valid) return;
              const parsed = priorityStyleSchema.safeParse(candidate);
              if (!parsed.success) {
                setError(t.priorityNameInvalid);
                return;
              }
              setSaving(true);
              setError(null);
              try {
                if (await onChange({ ...value, [priority]: parsed.data }))
                  onClose();
                else setError(t.prioritySaveFailed);
              } catch {
                setError(t.prioritySaveFailed);
              } finally {
                setSaving(false);
              }
            }}
          >
            <Text style={{ color: theme.colors.foreground }}>{t.save}</Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}
