import { useEffect, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

type Option = { value: string; label: string };

/** A small anchored selector; the native modal handles outside presses and Escape without clipping the menu. */
export function ToolbarSelect({
  id,
  title,
  label,
  value,
  options,
  onSelect,
  theme,
}: {
  id: string;
  title: string;
  label: string;
  value: string;
  options: readonly Option[];
  onSelect(value: string): void;
  theme: PluginSurfaceProps["theme"];
}) {
  const trigger = useRef<View>(null);
  const selected = useRef<View>(null);
  const [anchor, setAnchor] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const window = useWindowDimensions();
  useEffect(() => setAnchor(null), [window.width, window.height]);
  const close = () => {
    setAnchor(null);
    trigger.current?.focus();
  };
  const width = Math.min(190, Math.max(1, window.width - 16));
  const height = options.length * 40 + 12;
  return (
    <>
      <Pressable
        ref={trigger}
        testID={id}
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${label}`}
        accessibilityState={{ expanded: !!anchor }}
        aria-expanded={!!anchor}
        onPress={() => {
          trigger.current?.measureInWindow((x, y, width, height) =>
            setAnchor({ x, y, width, height }),
          );
        }}
        style={({ pressed }) => ({
          minHeight: 36,
          paddingHorizontal: 8,
          borderRadius: 6,
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          backgroundColor: pressed ? theme.colors.surface2 : "transparent",
        })}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
          {label}
        </Text>
        <Icon
          name={anchor ? "ChevronUp" : "ChevronDown"}
          size={13}
          color={theme.colors.foregroundMuted}
        />
      </Pressable>
      {anchor ? (
        <Modal
          visible
          transparent
          animationType="none"
          onRequestClose={close}
          onShow={() => selected.current?.focus()}
        >
          <View style={{ flex: 1 }}>
            <Pressable
              testID={`${id}-backdrop`}
              accessible={false}
              onPress={close}
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                bottom: 0,
                left: 0,
              }}
            />
            <View
              accessibilityRole="radiogroup"
              accessibilityLabel={title}
              testID={`${id}-options`}
              style={{
                position: "absolute",
                width,
                padding: 6,
                borderRadius: 9,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface1,
                shadowColor: "#000",
                shadowOpacity: 0.16,
                shadowRadius: 10,
                shadowOffset: { width: 0, height: 4 },
                elevation: 8,
                left: Math.max(
                  8,
                  Math.min(
                    anchor.x + anchor.width - width,
                    window.width - width - 8,
                  ),
                ),
                top: Math.max(
                  8,
                  anchor.y + anchor.height + 6 + height <= window.height - 8
                    ? anchor.y + anchor.height + 6
                    : anchor.y - height - 6,
                ),
              }}
            >
              {options.map((option) => (
                <Pressable
                  key={option.value}
                  ref={option.value === value ? selected : undefined}
                  testID={`${id}-option-${option.value}`}
                  accessibilityRole="radio"
                  accessibilityLabel={option.label}
                  accessibilityState={{ checked: option.value === value }}
                  aria-checked={option.value === value}
                  onPress={() => {
                    onSelect(option.value);
                    close();
                  }}
                  style={({ pressed }) => ({
                    minHeight: 40,
                    paddingHorizontal: 10,
                    borderRadius: 5,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    backgroundColor: pressed
                      ? theme.colors.surface2
                      : "transparent",
                  })}
                >
                  <View style={{ width: 14 }}>
                    {option.value === value ? (
                      <Icon
                        name="Check"
                        size={14}
                        color={theme.colors.foreground}
                      />
                    ) : null}
                  </View>
                  <Text
                    style={{ color: theme.colors.foreground, fontSize: 13 }}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </Modal>
      ) : null}
    </>
  );
}
