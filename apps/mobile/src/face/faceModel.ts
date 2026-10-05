// Pixel faces: data model, the 8-byte on-chain encoding and a 16x16 pixel grid renderer.
// Pure TypeScript (no React Native imports) so node tests can load it directly.
//
// On-chain face bytes: [skin, hairStyle, hairColor, eyes, accessory, mouth, 0, 0].
// Decoding takes every byte modulo its option count, so any 8 bytes render as a valid head.
// Heads only: no neck, shoulders or body in any combination.

export const GRID = 16;

export type Face = {
  skin: number;
  hairStyle: number;
  hairColor: number;
  eyes: number;
  accessory: number;
  mouth: number;
};

/** [base, shade] */
export const SKINS: readonly (readonly [string, string])[] = [
  ['#f9dcc4', '#e9bb9b'],
  ['#f0c39c', '#d9a079'],
  ['#d9a074', '#b97c52'],
  ['#b47a50', '#935f3b'],
  ['#8c5a3a', '#6e432a'],
  ['#5e3a26', '#47291b'],
];

/** [shade, base, highlight] */
export const HAIR_COLORS: readonly (readonly [string, string, string])[] = [
  ['#120c18', '#231829', '#3d2f4a'],
  ['#3b2418', '#5e3b27', '#80553a'],
  ['#b8862c', '#e8b84a', '#f8dc8a'],
  ['#9a3a14', '#d4602a', '#f08a4e'],
  ['#4b2aa6', '#7c4dff', '#a98bff'],
  ['#8e899f', '#c6c1d6', '#ecebf4'],
];

export const HAIR_COLOR_NAMES = ['Black', 'Brown', 'Blonde', 'Ginger', 'Violet', 'Silver'] as const;
export const HAIR_STYLE_NAMES = ['Short', 'Spiky', 'Bob', 'Long', 'Curly', 'Bun', 'Side', 'Buzz'] as const;
export const EYE_NAMES = ['Dots', 'Big', 'Happy', 'Sleepy'] as const;
export const ACCESSORY_NAMES = ['None', 'Glasses', 'Shades', 'Cap', 'Earrings', 'Headband'] as const;
export const MOUTH_NAMES = ['Smile', 'Flat', 'Open', 'Grin'] as const;
export const SKIN_NAMES = ['Porcelain', 'Light', 'Tan', 'Brown', 'Dark', 'Deep'] as const;

export const FACE_OPTIONS = {
  skin: SKINS.length,
  hairStyle: HAIR_STYLE_NAMES.length,
  hairColor: HAIR_COLORS.length,
  eyes: EYE_NAMES.length,
  accessory: ACCESSORY_NAMES.length,
  mouth: MOUTH_NAMES.length,
} as const;

export type FaceField = keyof typeof FACE_OPTIONS;
export const FACE_FIELDS: readonly FaceField[] = ['skin', 'hairStyle', 'hairColor', 'eyes', 'accessory', 'mouth'];

const mod = (value: number, count: number) => (((Math.trunc(value) % count) + count) % count);

export function normalizeFace(face: Face): Face {
  return {
    skin: mod(face.skin, FACE_OPTIONS.skin),
    hairStyle: mod(face.hairStyle, FACE_OPTIONS.hairStyle),
    hairColor: mod(face.hairColor, FACE_OPTIONS.hairColor),
    eyes: mod(face.eyes, FACE_OPTIONS.eyes),
    accessory: mod(face.accessory, FACE_OPTIONS.accessory),
    mouth: mod(face.mouth, FACE_OPTIONS.mouth),
  };
}

/** 8 bytes for `place_bet`: [skin, hairStyle, hairColor, eyes, accessory, mouth, 0, 0]. */
export function faceToBytes(face: Face): Uint8Array {
  const f = normalizeFace(face);
  return new Uint8Array([f.skin, f.hairStyle, f.hairColor, f.eyes, f.accessory, f.mouth, 0, 0]);
}

/** Any bytes (including a house position's zeros or a short array) decode to a valid face. */
export function faceFromBytes(bytes: ArrayLike<number>): Face {
  const at = (i: number) => (i < bytes.length ? Number(bytes[i]) || 0 : 0);
  return normalizeFace({ skin: at(0), hairStyle: at(1), hairColor: at(2), eyes: at(3), accessory: at(4), mouth: at(5) });
}

export function randomFace(random: () => number = Math.random): Face {
  const pick = (count: number) => Math.min(count - 1, Math.floor(random() * count));
  return {
    skin: pick(FACE_OPTIONS.skin),
    hairStyle: pick(FACE_OPTIONS.hairStyle),
    hairColor: pick(FACE_OPTIONS.hairColor),
    eyes: pick(FACE_OPTIONS.eyes),
    // Most players start without an accessory; it stays a choice in the editor.
    accessory: random() < 0.6 ? 0 : pick(FACE_OPTIONS.accessory),
    mouth: pick(FACE_OPTIONS.mouth),
  };
}

export function faceKey(face: Face): string {
  const f = normalizeFace(face);
  return `${f.skin}${f.hairStyle}${f.hairColor}${f.eyes}${f.accessory}${f.mouth}`;
}

/** Parses a stored face (JSON from AsyncStorage); null when it is not a face. */
export function parseStoredFace(value: unknown): Face | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  for (const field of FACE_FIELDS) if (typeof v[field] !== 'number') return null;
  return normalizeFace(v as unknown as Face);
}

// ---------------------------------------------------------------------------------------------
// Pixel art. Each layer is 16 strings of 16 characters; '.' is transparent.
// Layer order: back hair, head, eyes, mouth, front hair, accessory, then a 1-pixel outline.

const OUTLINE = '#0e0a16';
const EYE = '#1a1222';
const GLINT = '#ffffff';
const MOUTH = '#5a2335';
const TONGUE = '#c44d5e';
const TEETH = '#f4f0f8';
const FRAME = '#a8d7ff';
const SHADES = '#141018';
const SHADES_GLINT = '#5d5874';
const CAP = '#d8344a';
const CAP_SHADE = '#9e1f37';
const GOLD = '#f2c14e';
const BAND = '#35df6c';
const TEAR = '#7fd8ff';
const BLUSH = '#ff8fab';

const EMPTY = '................';

/** Head: S skin, e skin shade (ears, chin). */
const HEAD = [
  EMPTY, EMPTY, EMPTY, EMPTY, EMPTY,
  '....SSSSSSSS....', // y5
  '...SSSSSSSSSS...',
  '...SSSSSSSSSS...',
  '...SSSSSSSSSS...',
  '..eSSSSSSSSSSe..', // y9 ears
  '..eSSSSSSSSSSe..',
  '...SSSSSSSSSS...',
  '....SSSSSSSS....',
  '.....eeeeee.....', // y13 chin
  EMPTY, EMPTY,
];

/**
 * Hair: F base, f shade, h highlight are drawn over the face; B base, b shade behind it;
 * g is a gold hair tie.
 */
const HAIR: readonly (readonly string[])[] = [
  // 0 Short
  [
    EMPTY, EMPTY,
    '.....FFFFFF.....',
    '....FFhhhFFF....',
    '...FFFFFFFFFF...',
    '...FFFFFFFFFF...',
    '...FfF.ff..fF...',
    '...f........f...',
    EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY,
  ],
  // 1 Spiky
  [
    EMPTY,
    '....F..F..F.....',
    '....FF.FF.FF....',
    '...FFFFFFFFFF...',
    '...FFhFFFFhFF...',
    '...FFFFFFFFFF...',
    '...F.FF..FF.F...',
    '...f........f...',
    EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY,
  ],
  // 2 Bob
  [
    EMPTY, EMPTY,
    '.....FFFFFF.....',
    '....FFhhFFFF....',
    '...FFFFFFFFFF...',
    '..FFFFFFFFFFFF..',
    '..FFFFFFFFFFFF..',
    '..FF........FF..',
    '..FF........FF..',
    '..FF........FF..',
    '..FF........FF..',
    '..Ff........fF..',
    '..ff........ff..',
    EMPTY, EMPTY, EMPTY,
  ],
  // 3 Long
  [
    EMPTY, EMPTY,
    '.....FFFFFF.....',
    '....FFFhhFFF....',
    '...FFFFFFFFFF...',
    '..FFFFFFFFFFFF..',
    '..FFFFFFF..FFF..',
    '..FFFf......FF..',
    '..FF........FF..',
    '..FF........FF..',
    '..FF........FF..',
    '..FF........FF..',
    '..FF........FF..',
    '..Ff........fF..',
    '..ff........ff..',
    EMPTY,
  ],
  // 4 Curly
  [
    EMPTY,
    '.....FhFFhF.....',
    '...FFFFfFFFFF...',
    '..FhFFFFFFFFhF..',
    '.FFFFfFFFFfFFFF.',
    '.FfFFFFhFFFFFfF.',
    '.FFFfF.FF.FfFFF.',
    '.FFF........FFF.',
    '.FfF........FfF.',
    '.FF..........FF.',
    '..f..........f..',
    EMPTY, EMPTY, EMPTY, EMPTY, EMPTY,
  ],
  // 5 Bun
  [
    EMPTY,
    '......FhFF......',
    '.....FFFFFF.....',
    '......gggg......',
    '....FFFFFFFF....',
    '...FFhFFFFFFF...',
    '...FF......FF...',
    '...F........F...',
    EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY,
  ],
  // 6 Side
  [
    EMPTY, EMPTY,
    '....FFFFFFF.....',
    '...FFFFFFhhFF...',
    '..FFFFFFFFFFFF..',
    '..FFFFFFFFFFFF..',
    '..FFFFFFFF..FF..',
    '..FFFFf.....fF..',
    '..Ff.........F..',
    EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY,
  ],
  // 7 Buzz
  [
    EMPTY, EMPTY, EMPTY, EMPTY,
    '.....ffffff.....',
    '....fFfFFfFf....',
    '...f........f...',
    EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY,
  ],
];

type Pixel = readonly [x: number, y: number, color: string];

function eyePixels(eyes: number): Pixel[] {
  switch (eyes) {
    case 1: // Big, with a glint
      return [
        [5, 8, EYE], [6, 8, GLINT], [5, 9, EYE], [6, 9, EYE],
        [9, 8, EYE], [10, 8, GLINT], [9, 9, EYE], [10, 9, EYE],
      ];
    case 2: // Happy ^ ^
      return [
        [4, 9, EYE], [5, 8, EYE], [6, 9, EYE],
        [9, 9, EYE], [10, 8, EYE], [11, 9, EYE],
      ];
    case 3: // Sleepy lids
      return [[5, 9, EYE], [6, 9, EYE], [9, 9, EYE], [10, 9, EYE]];
    default: // Dots
      return [[5, 9, EYE], [10, 9, EYE]];
  }
}

function mouthPixels(mouth: number): Pixel[] {
  switch (mouth) {
    case 1: // Flat
      return [[7, 12, MOUTH], [8, 12, MOUTH]];
    case 2: // Open
      return [[7, 11, MOUTH], [8, 11, MOUTH], [7, 12, TONGUE], [8, 12, TONGUE]];
    case 3: // Grin
      return [[6, 11, MOUTH], [7, 11, TEETH], [8, 11, TEETH], [9, 11, MOUTH], [7, 12, MOUTH], [8, 12, MOUTH]];
    default: // Smile
      return [[6, 11, MOUTH], [7, 12, MOUTH], [8, 12, MOUTH], [9, 11, MOUTH]];
  }
}

/**
 * Render-time expressions for results (big win, rekt). They replace the mouth and add a detail;
 * the face itself and its 8 on-chain bytes stay the same.
 */
export type Expression = 'happy' | 'sad';
export const EXPRESSIONS: readonly Expression[] = ['happy', 'sad'];

function expressionPixels(expression: Expression): Pixel[] {
  if (expression === 'happy') {
    // Wide open grin with teeth and tongue, plus blushing cheeks.
    return [
      [5, 11, MOUTH], [6, 11, TEETH], [7, 11, TEETH], [8, 11, TEETH], [9, 11, TEETH], [10, 11, MOUTH],
      [6, 12, MOUTH], [7, 12, TONGUE], [8, 12, TONGUE], [9, 12, MOUTH],
      [4, 11, BLUSH], [11, 11, BLUSH],
    ];
  }
  // Frown (an upside-down smile) and a tear under the right eye.
  return [[6, 12, MOUTH], [7, 11, MOUTH], [8, 11, MOUTH], [9, 12, MOUTH], [11, 10, TEAR], [11, 11, TEAR]];
}

function row(y: number, x0: number, x1: number, color: string): Pixel[] {
  const out: Pixel[] = [];
  for (let x = x0; x <= x1; x++) out.push([x, y, color]);
  return out;
}

function accessoryPixels(accessory: number): Pixel[] {
  switch (accessory) {
    case 1: // Glasses: two round frames with a bridge and temples
      return [
        ...row(7, 4, 7, FRAME), ...row(10, 4, 7, FRAME),
        [4, 8, FRAME], [7, 8, FRAME], [4, 9, FRAME], [7, 9, FRAME],
        ...row(7, 8, 11, FRAME), ...row(10, 8, 11, FRAME),
        [8, 8, FRAME], [11, 8, FRAME], [8, 9, FRAME], [11, 9, FRAME],
        [3, 8, FRAME], [12, 8, FRAME],
      ];
    case 2: // Shades
      return [
        ...row(8, 4, 11, SHADES), ...row(9, 4, 7, SHADES), ...row(9, 8, 11, SHADES),
        [5, 8, SHADES_GLINT], [9, 8, SHADES_GLINT], [3, 8, SHADES], [12, 8, SHADES],
      ];
    case 3: // Cap (hair above the brim is cleared first)
      return [
        ...row(2, 5, 10, CAP), ...row(3, 4, 11, CAP), [7, 3, GLINT], ...row(4, 3, 12, CAP),
        ...row(5, 2, 13, CAP_SHADE),
      ];
    case 4: // Earrings
      return [[2, 11, GOLD], [13, 11, GOLD]];
    case 5: // Headband
      return row(6, 3, 12, BAND);
    default:
      return [];
  }
}

/** 256 colors (row-major), null for transparent. `expression` overrides the mouth at render time only. */
export function faceGrid(input: Face, expression?: Expression): (string | null)[] {
  const face = normalizeFace(input);
  const grid: (string | null)[] = new Array(GRID * GRID).fill(null);
  const put = (x: number, y: number, color: string) => {
    if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y * GRID + x] = color;
  };
  const [skin, skinShade] = SKINS[face.skin];
  const [hairShade, hairBase, hairLight] = HAIR_COLORS[face.hairColor];
  const hair = HAIR[face.hairStyle];
  const capOn = face.accessory === 3;

  // Back hair.
  hair.forEach((line, y) => {
    for (let x = 0; x < GRID; x++) {
      const c = line[x];
      if (capOn && y < 5) continue;
      if (c === 'B') put(x, y, hairBase);
      else if (c === 'b') put(x, y, hairShade);
    }
  });
  // Head.
  HEAD.forEach((line, y) => {
    for (let x = 0; x < GRID; x++) {
      const c = line[x];
      if (c === 'S') put(x, y, skin);
      else if (c === 'e') put(x, y, skinShade);
    }
  });
  for (const [x, y, c] of eyePixels(face.eyes)) put(x, y, c);
  for (const [x, y, c] of expression ? expressionPixels(expression) : mouthPixels(face.mouth)) put(x, y, c);
  // Front hair.
  hair.forEach((line, y) => {
    for (let x = 0; x < GRID; x++) {
      const c = line[x];
      if (capOn && y < 5) continue;
      if (c === 'F') put(x, y, hairBase);
      else if (c === 'f') put(x, y, hairShade);
      else if (c === 'h') put(x, y, hairLight);
      else if (c === 'g') put(x, y, GOLD);
    }
  });
  for (const [x, y, c] of accessoryPixels(face.accessory)) put(x, y, c);
  return withOutline(grid);
}

/** The house's marker: a small pixel house, never a person. */
const HOUSE = [
  EMPTY, EMPTY,
  '.......RR.......',
  '......RRRR......',
  '.....RRRRRR.....',
  '....RRRRRRRR....',
  '...RRRRRRRRRR...',
  '..rrrrrrrrrrrr..',
  '....WWWWWWWW....',
  '....WyWWWWyW....',
  '....WWWWWWWW....',
  '....WWWddWWW....',
  '....WWWddWWW....',
  '....WWWddWWW....',
  EMPTY, EMPTY,
];
const HOUSE_COLORS: Record<string, string> = { R: '#9c54ff', r: '#6e33c7', W: '#e6e0f1', y: '#f4bf3d', d: '#5b2d8f' };

export function houseGrid(): (string | null)[] {
  const grid: (string | null)[] = new Array(GRID * GRID).fill(null);
  HOUSE.forEach((line, y) => {
    for (let x = 0; x < GRID; x++) {
      const color = HOUSE_COLORS[line[x]];
      if (color) grid[y * GRID + x] = color;
    }
  });
  return withOutline(grid);
}

/** Adds a 1-pixel outline around every filled pixel (4-neighbourhood). */
function withOutline(grid: (string | null)[]): (string | null)[] {
  const out = grid.slice();
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (grid[y * GRID + x] !== null) continue;
      const filled =
        (x > 0 && grid[y * GRID + x - 1] !== null) ||
        (x < GRID - 1 && grid[y * GRID + x + 1] !== null) ||
        (y > 0 && grid[(y - 1) * GRID + x] !== null) ||
        (y < GRID - 1 && grid[(y + 1) * GRID + x] !== null);
      if (filled) out[y * GRID + x] = OUTLINE;
    }
  }
  return out;
}

/**
 * One SVG path per color: each horizontal run becomes "M x y h n v 1 h -n z".
 * Coordinates are logical pixels of the 16x16 viewBox.
 */
export function gridToPaths(grid: readonly (string | null)[]): { color: string; d: string }[] {
  const byColor = new Map<string, string[]>();
  for (let y = 0; y < GRID; y++) {
    let x = 0;
    while (x < GRID) {
      const color = grid[y * GRID + x];
      if (color === null) {
        x++;
        continue;
      }
      let end = x + 1;
      while (end < GRID && grid[y * GRID + end] === color) end++;
      const parts = byColor.get(color) ?? [];
      parts.push(`M${x} ${y}h${end - x}v1h${x - end}z`);
      byColor.set(color, parts);
      x = end;
    }
  }
  return [...byColor.entries()].map(([color, parts]) => ({ color, d: parts.join('') }));
}

/** Raw art layers, exported for the layout checks in test/face.test.ts. */
export const ART_LAYERS: Readonly<Record<string, readonly string[]>> = {
  head: HEAD,
  house: HOUSE,
  ...Object.fromEntries(HAIR.map((layer, i) => [`hair:${HAIR_STYLE_NAMES[i]}`, layer])),
};
