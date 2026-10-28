/* Inkslide annotate - stroke colors (pure, no DOM)
 *
 * The colors a stroke may have: the CSS colors that the screen (SVG) and the
 * annotated PDF export both draw the same way. Hex (#rgb, #rgba, #rrggbb,
 * #rrggbbaa), rgb()/rgba(), hsl()/hsla() (comma or space syntax, alpha after
 * a slash) and the 148 CSS color names plus `transparent`. Anything else
 * (currentColor, var(), color(), lab(), oklch(), …) is no stroke color.
 */

/** A color as RGB in 0..1 and alpha 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** The CSS color names (CSS Color 4). */
const NAMES: ReadonlyMap<string, string> = new Map(`
  aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc
  bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a
  burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50
  cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b
  darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b
  darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000
  darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f
  darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff
  dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0
  forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520
  gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4
  indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5
  lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff
  lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1
  lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899
  lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32
  linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd
  mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee
  mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970
  mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6
  olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa
  palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9
  peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399
  red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460
  seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd
  slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c
  teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff
  whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32
`.trim().split(/\s+/).map(e => e.split(':') as [string, string]));

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUMBER = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg|grad|rad|turn)?$/;
const clamp = (v: number): number => Math.min(1, Math.max(0, v));

/** A number with its unit ('' for none); null if `t` is not one. */
function token(t: string): { v: number; unit: string } | null {
  const m = NUMBER.exec(t);
  return m ? { v: parseFloat(m[1]), unit: m[2] || '' } : null;
}

/** Alpha as a number or a percentage; null if it is neither. */
function alpha(t: string | undefined): number | null {
  if (t === undefined) return 1;
  const a = token(t);
  if (!a || (a.unit && a.unit !== '%')) return null;
  return clamp(a.unit ? a.v / 100 : a.v);
}

function fromHex(hex: string): Rgba {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map(c => c + c).join('');
  const byte = (i: number): number => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: byte(0), g: byte(2), b: byte(4), a: h.length === 8 ? byte(6) : 1 };
}

function fromHsl(h: number, s: number, l: number, a: number): Rgba {
  const k = (n: number): number => (n + h / 30) % 12;
  const c = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - c * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const ch = (n: number): number => clamp(Math.round(f(n) * 1e9) / 1e9); // no 1e-16 left over
  return { r: ch(0), g: ch(8), b: ch(4), a };
}

/** The arguments of rgb()/hsl(): three values and the alpha (undefined if none); null if malformed. */
function args(body: string): { values: string[]; alpha?: string } | null {
  if (body.includes(',')) { // rgb(1, 2, 3) or rgba(1, 2, 3, 0.5)
    const parts = body.split(',').map(p => p.trim());
    return parts.length === 3 || parts.length === 4 ? { values: parts.slice(0, 3), alpha: parts[3] } : null;
  }
  const [main, a, ...rest] = body.split('/'); // rgb(1 2 3 / 0.5)
  const values = main.trim().split(/\s+/);
  if (rest.length || values.length !== 3 || (a !== undefined && !a.trim())) return null;
  return { values, alpha: a === undefined ? undefined : a.trim() };
}

/** `css` as RGB and alpha if it is a stroke color (see the module comment); else null. */
export function colorRgba(css: unknown): Rgba | null {
  if (typeof css !== 'string') return null;
  const s = css.trim().toLowerCase();
  if (HEX.test(s)) return fromHex(s);
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMES.get(s);
  if (named) return fromHex(`#${named}`);
  const m = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(s);
  const parsed = m && args(m[2]);
  if (!m || !parsed) return null;
  const a = alpha(parsed.alpha);
  const [x, y, z] = parsed.values.map(token);
  if (a === null || !x || !y || !z) return null;
  if (m[1].startsWith('rgb')) {
    const channel = (t: { v: number; unit: string }): number | null =>
      (t.unit === '%' ? clamp(t.v / 100) : t.unit ? null : clamp(t.v / 255));
    const [r, g, b] = [channel(x), channel(y), channel(z)];
    return r === null || g === null || b === null ? null : { r, g, b, a };
  }
  const turns: Record<string, number> = { '': 1 / 360, deg: 1 / 360, grad: 1 / 400, rad: 1 / (2 * Math.PI), turn: 1 };
  // Hue: a number (degrees) or an angle; saturation and lightness: percentages (or plain numbers).
  if (!(x.unit in turns) || (y.unit && y.unit !== '%') || (z.unit && z.unit !== '%')) return null;
  const hue = ((x.v * turns[x.unit]) % 1 + 1) % 1 * 360;
  return fromHsl(hue, clamp(y.v / 100), clamp(z.v / 100), a);
}

const byte = (v: number): string => Math.round(v * 255).toString(16).padStart(2, '0');

/**
 * `css` as it is stored in a stroke: hex as written, any other stroke color
 * as #rrggbb (#rrggbbaa if not opaque); null if it is no stroke color.
 */
export function normalizeColor(css: unknown): string | null {
  if (typeof css === 'string' && HEX.test(css)) return css;
  const c = colorRgba(css);
  if (!c) return null;
  const a = byte(c.a);
  return `#${byte(c.r)}${byte(c.g)}${byte(c.b)}${a === 'ff' ? '' : a}`;
}
