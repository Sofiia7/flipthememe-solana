import { StyleSheet } from 'react-native';

export const C = {
  bg: '#100d1f',
  panel: '#1c1830',
  panelDeep: '#19152a',
  chart: '#171326',
  border: '#454055',
  borderSoft: '#2e2842',
  accent: '#9c54ff',
  accentSoft: '#a459ff',
  accentText: '#e0c1ff',
  white: '#ffffff',
  text: '#e6e0f1',
  subtle: '#9f9aad',
  // Quiet text: 5.1:1 on the panels (#1c1830) and 5.7:1 on the background, above the 4.5:1 AA line.
  dim: '#8f88a3',
  label: '#a89aba',
  up: '#35df6c',
  upBorder: '#84ff9d',
  upInk: '#102315',
  down: '#fb607c',
  downBorder: '#ff9db0',
  downInk: '#2a0d14',
  gold: '#f4bf3d',
  warn: '#ffb347',
  danger: '#ff5d73',
  house: '#c9a7ff',
  // Neon accents on the dark background.
  neonGreen: '#3dff8b',
  neonRed: '#ff3d6e',
  neonYellow: '#ffe14d',
  neonPurple: '#b46cff',
  neonPink: '#ff4fd8',
} as const;

/** Gradient stops (top to bottom). */
export const GRAD = {
  up: ['#6dffa2', '#22c95c', '#119140'],
  down: ['#ff8aa2', '#f23f66', '#b81840'],
  gold: ['#ffe680', '#f6b62d', '#d9870f'],
  purple: ['#c58bff', '#8a3dff', '#5a1fc2'],
  win: ['#3b0f73', '#1a0b3a', '#07050f'],
  rekt: ['#4a0b1f', '#1d0712', '#07050f'],
  card: ['#34106a', '#160b33', '#07050f'],
} as const;

export const MONO = 'monospace';

/**
 * Largest system font scale the fixed-height UI (tab bar, timer, X lane, buttons, token line) follows. React 19 has no
 * Text.defaultProps, so it is passed as maxFontSizeMultiplier on those Text elements; scrolling screens scale freely.
 */
export const FONT_CAP = 1.5;

export const T = StyleSheet.create({
  label: { color: C.label, fontSize: 10, fontWeight: '900', letterSpacing: 0.5 },
  subtle: { color: C.subtle, fontSize: 11, lineHeight: 16 },
  dim: { color: C.dim, fontSize: 11, lineHeight: 15 },
  panel: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, padding: 10, gap: 6 },
  link: { color: C.accentText, fontSize: 11, textDecorationLine: 'underline' },
});
