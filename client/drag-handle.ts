import { useEffect, useMemo, useRef, type RefObject } from "react";
import { PanResponder, type View } from "react-native";

export type Bounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type HandleProps = {
  measure: RefObject<View | null>;
  disabled: boolean;
  cancelKey?: string;
  horizontal?: boolean;
  captureStart?: boolean;
  onBegin(rect: Bounds, x: number, y: number): void;
  onMove(x: number, y: number): void;
  onEnd(x: number, y: number): void;
  onCancel(): void;
  onTap?(): void;
};

export function useDragHandle(props: HandleProps) {
  const latest = useRef(props);
  latest.current = props;
  const active = useRef(false);
  const generation = useRef(0);
  const initiated = useRef(false);
  const origin = useRef({ x: 0, y: 0 });
  useEffect(() => {
    active.current = false;
    generation.current += 1;
    return () => {
      active.current = false;
      generation.current += 1;
    };
  }, [props.cancelKey]);
  const activate = (gesture: { moveX: number; moveY: number }) => {
    initiated.current = true;
    const cancelKey = latest.current.cancelKey;
    const currentGeneration = generation.current;
    latest.current.measure.current?.measureInWindow(
      (left, top, width, height) => {
        if (
          !active.current ||
          latest.current.disabled ||
          latest.current.cancelKey !== cancelKey ||
          generation.current !== currentGeneration
        )
          return;
        latest.current.onBegin(
          { left, top, width, height },
          origin.current.x,
          origin.current.y,
        );
        latest.current.onMove(gesture.moveX, gesture.moveY);
      },
    );
  };
  return useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: (event) => {
          origin.current = {
            x: event.nativeEvent.pageX,
            y: event.nativeEvent.pageY,
          };
          return !!latest.current.captureStart && !latest.current.disabled;
        },
        onMoveShouldSetPanResponderCapture: (_, gesture) =>
          !latest.current.disabled &&
          (latest.current.horizontal
            ? Math.abs(gesture.dx) >= 6 &&
              Math.abs(gesture.dx) >= Math.abs(gesture.dy)
            : Math.hypot(gesture.dx, gesture.dy) >= 6),
        onPanResponderGrant: (_, gesture) => {
          active.current = true;
          generation.current += 1;
          initiated.current = false;
          if (!latest.current.captureStart) activate(gesture);
        },
        onPanResponderMove: (_, gesture) => {
          if (!active.current) return;
          if (initiated.current)
            latest.current.onMove(gesture.moveX, gesture.moveY);
          else if (Math.hypot(gesture.dx, gesture.dy) >= 6) activate(gesture);
        },
        onPanResponderRelease: (_, gesture) => {
          const wasActive = active.current;
          active.current = false;
          if (wasActive && initiated.current)
            latest.current.onEnd(gesture.moveX, gesture.moveY);
          else if (wasActive && !latest.current.disabled)
            latest.current.onTap?.();
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderTerminate: () => {
          active.current = false;
          latest.current.onCancel();
        },
      }),
    [],
  ).panHandlers;
}
