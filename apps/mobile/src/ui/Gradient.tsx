import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { gradientModule } from '../lib/nativeOptional';

export type GradientColors = readonly [string, string, ...string[]];

/** Linear gradient (top to bottom unless `horizontal`); a flat first color on a client without the native view. */
export function Gradient({
  colors,
  horizontal = false,
  style,
  children,
  pointerEvents,
}: {
  colors: GradientColors;
  horizontal?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  pointerEvents?: 'box-none' | 'none' | 'box-only' | 'auto';
}) {
  const LinearGradient = gradientModule()?.LinearGradient;
  if (!LinearGradient) {
    return (
      <View style={[{ backgroundColor: colors[0] }, style]} pointerEvents={pointerEvents}>
        {children}
      </View>
    );
  }
  return (
    <LinearGradient
      colors={colors}
      start={{ x: 0, y: 0 }}
      end={horizontal ? { x: 1, y: 0 } : { x: 0, y: 1 }}
      style={style}
      pointerEvents={pointerEvents}
    >
      {children}
    </LinearGradient>
  );
}
