/* Inkslide web - records the animated demo in the README (docs/media/demo.gif).
 *
 * Builds the web front end, serves it with `vite preview`, opens a sample PDF
 * made here with pdf-lib (no third-party content), draws with synthetic pen
 * events in headless Chromium, takes a screenshot per frame and assembles the
 * frames into a GIF with ffmpeg (two passes: palette, then dithering).
 *
 *   pnpm --filter @inkslide/web demo [output.gif]
 *
 * Needs ffmpeg on the PATH and the Playwright Chromium (`npx playwright install
 * chromium`). INKSLIDE_DEMO_PORT picks the preview port (default: a free one). */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] || join(WEB, '../../docs/media/demo.gif'));
const FPS = 15;
const VIEWPORT = { width: 1600, height: 900 };
const GIF_WIDTH = 1200;

/** A free TCP port on localhost. */
const freePort = () => new Promise((ok, fail) => {
  const srv = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => ok(port));
  });
});

/** Two 16:9 lecture slides drawn with pdf-lib. */
async function samplePdf(file) {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Inkslide demo');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.12, 0.12, 0.14);
  const accent = rgb(0.12, 0.39, 0.78);
  const W = 960, H = 540;
  const header = (page, title, n) => {
    page.drawRectangle({ x: 0, y: H - 84, width: W, height: 84, color: rgb(0.95, 0.96, 0.98) });
    page.drawRectangle({ x: 0, y: H - 88, width: W, height: 4, color: accent });
    page.drawText(title, { x: 48, y: H - 58, size: 32, font: bold, color: ink });
    page.drawText(`Signals and Systems  ·  ${n}`, { x: 48, y: 24, size: 12, font, color: rgb(0.5, 0.5, 0.55) });
  };

  // Slide 1: a sine wave with labelled axes and two bullet points.
  const p1 = pdf.addPage([W, H]);
  header(p1, 'Sampling a sine wave', 1);
  const ox = 90, oy = 250, len = 480, amp = 100;
  p1.drawLine({ start: { x: ox, y: oy }, end: { x: ox + len + 20, y: oy }, thickness: 1.5, color: ink });
  p1.drawLine({ start: { x: ox, y: oy - amp - 20 }, end: { x: ox, y: oy + amp + 20 }, thickness: 1.5, color: ink });
  p1.drawText('t', { x: ox + len + 26, y: oy - 5, size: 16, font, color: ink });
  p1.drawText('x(t)', { x: ox - 14, y: oy + amp + 28, size: 16, font, color: ink });
  let prev = null;
  for (let i = 0; i <= 120; i++) {
    const x = ox + (len * i) / 120, y = oy + amp * Math.sin((4 * Math.PI * i) / 120);
    if (prev) p1.drawLine({ start: prev, end: { x, y }, thickness: 2.5, color: accent });
    prev = { x, y };
  }
  for (let k = 0; k <= 12; k++) {
    const x = ox + (len * k) / 12, y = oy + amp * Math.sin((4 * Math.PI * k) / 12);
    p1.drawLine({ start: { x, y: oy }, end: { x, y }, thickness: 1, color: rgb(0.6, 0.6, 0.65) });
    p1.drawCircle({ x, y, size: 4, color: ink });
  }
  const bullets = ['Sample every T seconds: x[n] = x(nT)', 'Nyquist: sample faster than twice', 'the highest frequency, fs > 2 fmax'];
  bullets.forEach((text, i) => {
    if (i !== 2) p1.drawCircle({ x: 628, y: 336 - i * 36 + 6, size: 3.5, color: accent });
    p1.drawText(text, { x: 642, y: 336 - i * 36, size: 17, font, color: ink, maxWidth: 300 });
  });

  // Slide 2: a block diagram.
  const p2 = pdf.addPage([W, H]);
  header(p2, 'From analog to digital', 2);
  const blocks = ['Anti-alias filter', 'Sampler', 'Quantizer'];
  blocks.forEach((label, i) => {
    const x = 120 + i * 260;
    p2.drawRectangle({ x, y: 250, width: 180, height: 80, borderColor: accent, borderWidth: 2.5, color: rgb(1, 1, 1) });
    p2.drawText(label, { x: x + 90 - font.widthOfTextAtSize(label, 18) / 2, y: 283, size: 18, font, color: ink });
    if (i < 2) p2.drawLine({ start: { x: x + 180, y: 290 }, end: { x: x + 260, y: 290 }, thickness: 2, color: ink });
  });
  p2.drawLine({ start: { x: 50, y: 290 }, end: { x: 120, y: 290 }, thickness: 2, color: ink });
  p2.drawLine({ start: { x: 820, y: 290 }, end: { x: 900, y: 290 }, thickness: 2, color: ink });
  p2.drawText('x(t)', { x: 56, y: 302, size: 16, font, color: ink });
  p2.drawText('x[n]', { x: 860, y: 302, size: 16, font, color: ink });
  writeFileSync(file, await pdf.save());
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
}

async function waitFor(url, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`${url} did not start`);
}

async function main() {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) throw new Error('ffmpeg is needed on the PATH');
  const tmp = mkdtempSync(join(tmpdir(), 'inkslide-demo-'));
  const pdfFile = join(tmp, 'sampling.pdf');
  const framesDir = join(tmp, 'frames');
  run('mkdir', ['-p', framesDir]);
  await samplePdf(pdfFile);

  const vite = join(WEB, 'node_modules/.bin/vite');
  run(vite, ['build', '--logLevel', 'warn'], { cwd: WEB });
  const port = Number(process.env.INKSLIDE_DEMO_PORT) || await freePort();
  const server = spawn(vite, ['preview', '--port', String(port), '--strictPort'], { cwd: WEB, stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    await waitFor(`http://localhost:${port}/`);
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await page.goto(`http://localhost:${port}/`);
    await page.addStyleTag({ content: `
      #demo-pen { position: fixed; z-index: 99999; pointer-events: none; width: 14px; height: 14px;
        margin: -7px 0 0 -7px; border-radius: 50%; border: 2px solid rgba(0,0,0,.55);
        background: rgba(255,255,255,.6); display: none; }` });

    let frame = 0;
    const shot = async (repeat = 1) => {
      const png = await page.screenshot({ type: 'png' });
      for (let i = 0; i < repeat; i++) writeFileSync(join(framesDir, `${String(frame++).padStart(5, '0')}.png`), png);
    };
    const hold = seconds => shot(Math.round(seconds * FPS));

    // Pen helpers in the page: one stroke spans several evaluate calls (one per frame).
    await page.evaluate(() => {
      const dot = document.createElement('div');
      dot.id = 'demo-pen';
      document.body.append(dot);
      let target = null;
      const fire = (type, x, y, pressure, buttons) => target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'pen', isPrimary: true,
        button: type === 'pointermove' ? -1 : 0, buttons, pressure, clientX: x, clientY: y,
      }));
      const show = (x, y) => { dot.style.display = 'block'; dot.style.left = `${x}px`; dot.style.top = `${y}px`; };
      window.demoPen = {
        down(x, y, p) { target = document.elementFromPoint(x, y); show(x, y); fire('pointerover', x, y, 0, 0); fire('pointerdown', x, y, p, 1); },
        move(points) { for (const [x, y, p] of points) { fire('pointermove', x, y, p, 1); show(x, y); } },
        up(x, y) { fire('pointerup', x, y, 0, 0); },
        hide() { dot.style.display = 'none'; },
      };
    });

    /** Draw a stroke along f(t), t in [0, 1], in page fractions; `perFrame` points per frame. */
    const stroke = async (f, { points = 40, perFrame = 4 } = {}) => {
      const box = (await page.locator('.ink-page').boundingBox());
      const at = t => { const [u, v] = f(t); return [box.x + box.width * u, box.y + box.height * v, 0.35 + 0.45 * Math.sin(Math.PI * t)]; };
      const [x0, y0] = at(0);
      await page.evaluate(([x, y]) => window.demoPen.down(x, y, 0.3), [x0, y0]);
      for (let i = 1; i <= points; i += perFrame) {
        const chunk = [];
        for (let j = i; j < i + perFrame && j <= points; j++) chunk.push(at(j / points));
        await page.evaluate(c => window.demoPen.move(c), chunk);
        await shot();
      }
      const [x1, y1] = at(1);
      await page.evaluate(([x, y]) => window.demoPen.up(x, y), [x1, y1]);
      await shot();
    };
    const line = (a, b) => t => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const click = async sel => {
      await page.evaluate(() => window.demoPen.hide());
      await page.locator(sel).click();
      await shot(Math.round(0.4 * FPS));
    };

    // Start screen, then open the PDF through the file input.
    await hold(1);
    await page.evaluate(() => { delete window.showOpenFilePicker; });
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.ink-open').click();
    await (await chooser).setFiles(pdfFile);
    await page.locator('.ink-page svg.ann-page').waitFor();
    await page.waitForFunction(() => document.querySelector('canvas.ink-pdf')?.width > 500);
    await page.waitForTimeout(500);
    await hold(1.2);

    // Slide 1: highlight the Nyquist line, circle a sample, underline in red, an arrow in blue.
    await click('.ann-bar [data-id="highlighter"]');
    await click('.ann-bar [data-id="color-yellow"]');
    await stroke(line([0.665, 0.437], [0.955, 0.437]), { points: 28 });
    await click('.ann-bar [data-id="pen"]');
    await click('.ann-bar [data-id="color-red"]');
    await stroke(t => [0.174 + 0.04 * Math.cos(2.15 * Math.PI * t - 0.5), 0.38 + 0.075 * Math.sin(2.15 * Math.PI * t - 0.5)], { points: 44 });
    await stroke(line([0.84, 0.53], [0.955, 0.528]), { points: 16 });
    await click('.ann-bar [data-id="color-blue"]');
    await stroke(t => [0.42 - 0.18 * t, 0.22 + 0.11 * t - 0.06 * Math.sin(Math.PI * t)], { points: 30 });
    await stroke(line([0.27, 0.315], [0.24, 0.33]), { points: 8, perFrame: 2 });
    await stroke(line([0.255, 0.285], [0.24, 0.33]), { points: 8, perFrame: 2 });
    await page.evaluate(() => window.demoPen.hide());
    await hold(1.2);

    // Next slide: a green check mark and a note.
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(400);
    await hold(0.8);
    await click('.ann-bar [data-id="color-green"]');
    await stroke(t => (t < 0.35 ? [0.43 + 0.03 * (t / 0.35), 0.73 + 0.05 * (t / 0.35)] : [0.46 + 0.07 * ((t - 0.35) / 0.65), 0.78 - 0.14 * ((t - 0.35) / 0.65)]), { points: 24 });
    await stroke(t => [0.6 + 0.22 * t, 0.72 + 0.02 * Math.sin(6 * Math.PI * t)], { points: 30 });
    await page.evaluate(() => window.demoPen.hide());
    await hold(1.5);

    // Overview with both annotated slides.
    await page.keyboard.press('g');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    await hold(2);
  } finally {
    await browser.close();
    server.kill();
  }

  // Frames to GIF: one palette for the whole clip, only changed rectangles re-encoded.
  run('mkdir', ['-p', dirname(OUT)]);
  const scale = `fps=${FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;
  const palette = join(tmp, 'palette.png');
  run('ffmpeg', ['-v', 'error', '-y', '-framerate', String(FPS), '-i', join(framesDir, '%05d.png'),
    '-vf', `${scale},palettegen=stats_mode=diff`, palette]);
  run('ffmpeg', ['-v', 'error', '-y', '-framerate', String(FPS), '-i', join(framesDir, '%05d.png'), '-i', palette,
    '-lavfi', `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, OUT]);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`${OUT}: ${(statSync(OUT).size / 1e6).toFixed(2)} MB`);
}

main().catch(e => { console.error(e); process.exit(1); });
