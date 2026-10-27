export const Animated = { Value: class {}, timing() {} };
export const PanResponder = { create() {} };
export const Platform = { OS: "native" };
export const Pressable = () => null;
export const StyleSheet = { create: <T>(styles: T) => styles };
export const Text = () => null;
export const View = () => null;

export const Modal = () => null;
export const useWindowDimensions = () => ({
  width: 1440,
  height: 1000,
  scale: 1,
  fontScale: 1,
});
