import { describe, expect, it } from 'vitest';
import { colorRgba, normalizeColor } from '../src/color';

describe('stroke colors', () => {
  it('keeps hex as written', () => {
    for (const c of ['#000', '#ABC', '#be1e3c', '#ffd20080', '#0f08']) expect(normalizeColor(c)).toBe(c);
  });

  it('stores rgb(), hsl(), names and transparent as hex', () => {
    expect(normalizeColor('rgb(255, 0, 0)')).toBe('#ff0000');
    expect(normalizeColor('RGBA(0 0 255 / 50%)')).toBe('#0000ff80');
    expect(normalizeColor('rgb(10% 20% 30%)')).toBe('#1a334d');
    expect(normalizeColor('hsl(120, 100%, 25%)')).toBe('#008000');
    expect(normalizeColor('hsla(240, 100%, 50%, 0.5)')).toBe('#0000ff80');
    expect(normalizeColor('hsl(0.5turn 100% 50%)')).toBe('#00ffff');
    expect(normalizeColor('hsl(-120deg 100 50)')).toBe('#0000ff');
    expect(normalizeColor(' rebeccapurple ')).toBe('#663399');
    expect(normalizeColor('DarkSlateGrey')).toBe('#2f4f4f');
    expect(normalizeColor('transparent')).toBe('#00000000');
    expect(normalizeColor('rgba(0, 0, 0, 0.999)')).toBe('#000000'); // opaque once rounded
  });

  it('knows all 148 CSS color names', () => {
    const names = `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown
      burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod
      darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon
      darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey
      dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey
      honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral
      lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue
      lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine
      mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise
      mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered
      orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple
      rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue
      slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
      yellowgreen`.split(/\s+/);
    expect(names).toHaveLength(148);
    for (const n of names) expect(normalizeColor(n), n).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('is null for anything the export could not draw', () => {
    for (const c of ['', '5', 'currentColor', 'inherit', 'var(--ink)', 'oklch(0.5 0.2 30)', 'lab(50 20 30)',
      'color(srgb 1 0 0)', 'rgb(1, 2)', 'rgb(1 2 3 4)', 'rgb(1, 2, 3 / 4)', 'rgb(1px, 2, 3)', 'hsl(1, 2deg, 3%)',
      'rgb(none 0 0)', '#12345', 'red blue', 5, null, undefined, {}]) {
      expect(normalizeColor(c), String(c)).toBeNull();
    }
  });

  it('gives RGB and alpha in 0..1, clamped', () => {
    expect(colorRgba('rgb(300, -5, 128)')).toEqual({ r: 1, g: 0, b: 128 / 255, a: 1 });
    expect(colorRgba('hsl(0 100% 50% / 2)')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(colorRgba('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});
