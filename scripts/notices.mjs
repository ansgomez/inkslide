// Regenerate the generated parts of THIRD_PARTY_NOTICES.md from the installed
// dependency trees (`pnpm notices`):
//
//   js       the production dependencies of apps/web (and of the workspace
//            packages it uses) with their license texts, and PDF.js's data
//            files (CMaps, fonts, wasm decoders, ICC profile) with theirs;
//   desktop  Electron (its Chromium notices ship as LICENSES.chromium.html);
//   rust     (`pnpm notices --rust`, needs cargo and may download crates)
//            the Tauri crates of the mobile app, counted per license for the
//            Android and iOS targets.
//
// Each part replaces the text between its `<!-- BEGIN GENERATED: x -->` and
// `<!-- END GENERATED: x -->` markers; the prose around them is hand-written.
// `--check` exits 1 when the js and desktop parts are out of date.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFJS_DIRS, PDFJS_SKIP } from '../apps/web/plugins/pdfjs-files.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOTICES = join(root, 'THIRD_PARTY_NOTICES.md');
const args = process.argv.slice(2);

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const fence = text => {
  const body = text.replace(/\r\n/g, '\n').trimEnd();
  if (body.includes('```')) throw new Error('license text contains a code fence');
  return '```text\n' + body + '\n```';
};

/** Node's lookup of `name` from the (real) directory `from`. */
function resolvePackage(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`cannot find ${name} from ${from}`);
  }
}

/** Top-level license, notice and copyright files of a package. */
const licenseFiles = dir => readdirSync(dir)
  .filter(f => /^(licen[cs]e|notice|copying|copyrightnotice)/i.test(f) && !/\.spdx$/i.test(f))
  .sort();

/**
 * Extra license text a package's own files do not carry, read from the
 * package itself or a sibling: pako's zlib port is under the Zlib license
 * (stated in its source headers, not in LICENSE); the Tauri plugins ship only
 * an SPDX file, so the MIT text of @tauri-apps/api (same project) is used.
 */
const EXTRA = {
  pako: dir => [['lib/zlib/deflate.js (Zlib license of the zlib port)', leadingComment(join(dir, 'lib/zlib/deflate.js'))]],
  '@tauri-apps/plugin-dialog': tauriMit,
  '@tauri-apps/plugin-fs': tauriMit,
};
/** The first block of `//` comment lines of a source file, without the slashes. */
function leadingComment(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex(l => l.startsWith('//'));
  const end = lines.findIndex((l, i) => i > start && !l.startsWith('//'));
  return lines.slice(start, end).map(l => l.replace(/^\/\/ ?/, '')).join('\n');
}
function tauriMit(dir) {
  const api = resolvePackage('@tauri-apps/api', join(root, 'apps/web'));
  return [['LICENSE.spdx', readFileSync(join(dir, 'LICENSE.spdx'), 'utf8').split('\n')
    .filter(l => /^(PackageLicenseDeclared|PackageCopyrightText|PackageSupplier):/.test(l)).join('\n')],
  ['MIT text (from @tauri-apps/api LICENSE-MIT, same project)', readFileSync(join(api, 'LICENSE-MIT'), 'utf8')]];
}

/**
 * The production dependency tree of apps/web: npm packages reached through
 * `dependencies` (workspace packages are followed but not listed).
 * Optional dependencies are skipped: pdfjs-dist's @napi-rs/canvas is a
 * Node-only native module that the browser build never includes.
 */
function webPackages() {
  const found = new Map();
  const visit = (dir, isWorkspace) => {
    const pkg = readJson(join(dir, 'package.json'));
    const key = `${pkg.name}@${pkg.version}`;
    if (found.has(key)) return;
    if (!isWorkspace) found.set(key, { dir, pkg });
    for (const [name, range] of Object.entries(pkg.dependencies || {})) {
      visit(resolvePackage(name, dir), String(range).startsWith('workspace:'));
    }
  };
  visit(join(root, 'apps/web'), true);
  return [...found.values()].sort((a, b) => a.pkg.name.localeCompare(b.pkg.name) || a.pkg.version.localeCompare(b.pkg.version));
}

const urlOf = pkg => {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const url = pkg.homepage || repo || '';
  return url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://')
    .replace(/^(?!https?:)([\w-]+\/[\w.-]+)$/, 'https://github.com/$1');
};

function packageSection({ dir, pkg }) {
  const files = licenseFiles(dir);
  const extra = EXTRA[pkg.name]?.(dir) ?? [];
  if (!files.length && !extra.length) throw new Error(`${pkg.name} has no license file; add it to EXTRA`);
  const url = urlOf(pkg);
  const out = [`### ${pkg.name} ${pkg.version}`, '', `License: ${pkg.license}${url ? ` · ${url}` : ''}`, ''];
  for (const f of files) out.push(`${f}:`, '', fence(readFileSync(join(dir, f), 'utf8')), '');
  for (const [label, text] of extra) out.push(`${label}:`, '', fence(text), '');
  return out.join('\n');
}

/**
 * PDF.js data files copied to dist/pdfjs/ (PDFJS_DIRS, without PDFJS_SKIP),
 * with the license files next to them. Every shipped file must match a rule.
 */
const PDFJS_DATA = [
  { dir: 'cmaps', glob: '*.bcmap', what: 'Adobe CMaps (character maps for CJK fonts)', spdx: 'BSD-3-Clause', licenses: ['LICENSE'] },
  { dir: 'standard_fonts', glob: 'Foxit*.pfb', what: 'Foxit standard 14 font substitutes (from PDFium)', spdx: 'BSD-3-Clause', licenses: ['LICENSE_FOXIT'] },
  { dir: 'standard_fonts', glob: 'LiberationSans-*.ttf', what: 'Liberation Sans fonts', spdx: 'OFL-1.1', licenses: ['LICENSE_LIBERATION'] },
  { dir: 'wasm', glob: 'jbig2*', what: 'JBIG2 decoder (PDFium code compiled to wasm)', spdx: 'BSD-3-Clause AND Apache-2.0', licenses: ['LICENSE_JBIG2', 'LICENSE_PDFJS_JBIG2'] },
  { dir: 'wasm', glob: 'openjpeg*', what: 'OpenJPEG JPEG 2000 decoder (wasm)', spdx: 'BSD-2-Clause', licenses: ['LICENSE_OPENJPEG', 'LICENSE_PDFJS_OPENJPEG'] },
  { dir: 'wasm', glob: 'qcms*', what: 'qcms colour management (wasm)', spdx: 'MIT AND BSD-2-Clause', licenses: ['LICENSE_QCMS', 'LICENSE_PDFJS_QCMS'] },
  { dir: 'iccs', glob: '*.icc', what: 'CGATS001 ICC profile', spdx: 'CC0-1.0', licenses: ['LICENSE'] },
].map(r => ({ ...r, files: new RegExp(`^${r.glob.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`) }));

function pdfjsDataSection(pdfjsDir) {
  const listing = d => (existsSync(join(pdfjsDir, d)) ? readdirSync(join(pdfjsDir, d), { recursive: true }) : [])
    .filter(f => !PDFJS_SKIP.test(`${d}/${f}`) && !statSync(join(pdfjsDir, d, f)).isDirectory());
  const shipped = new Map(PDFJS_DIRS.map(d => [d, listing(d)]));
  for (const [d, files] of shipped) {
    for (const f of files) {
      if (!PDFJS_DATA.some(r => r.dir === d && (r.files.test(f) || r.licenses.includes(f)))) {
        throw new Error(`pdfjs-dist/${d}/${f} is shipped but matches no license rule`);
      }
    }
  }
  const out = ['#### PDF.js data files (`pdfjs/` in the build)', '',
    'Shipped with the license files next to them; the scripting sandbox (`wasm/quickjs-eval.*`) is not shipped.', '',
    '| Files | What | License |', '|---|---|---|',
    ...PDFJS_DATA.map(r => `| \`${r.dir}/${r.glob}\` (${shipped.get(r.dir).filter(f => r.files.test(f)).length}) | ${r.what} | ${r.spdx} |`), ''];
  for (const r of PDFJS_DATA) {
    for (const l of r.licenses) out.push(`\`${r.dir}/${l}\`:`, '', fence(readFileSync(join(pdfjsDir, r.dir, l), 'utf8')), '');
  }
  return out.join('\n');
}

function jsPart() {
  const pkgs = webPackages();
  const out = ['## Web front end (browser, PWA, Electron and Tauri)', '',
    `Generated by \`pnpm notices\` from the production dependencies of apps/web (${pkgs.length} packages).`, '',
    '| Package | Version | License |', '|---|---|---|',
    ...pkgs.map(({ pkg }) => `| ${pkg.name} | ${pkg.version} | ${pkg.license} |`), ''];
  for (const p of pkgs) {
    out.push(packageSection(p));
    if (p.pkg.name === 'pdfjs-dist') out.push(pdfjsDataSection(p.dir));
  }
  return out.join('\n');
}

function desktopPart() {
  const electron = resolvePackage('electron', join(root, 'apps/desktop'));
  const pkg = readJson(join(electron, 'package.json'));
  return ['## Desktop (Electron)', '',
    'The desktop installers contain Electron (with Chromium, V8, Node.js and FFmpeg). electron-builder copies',
    "Electron's `LICENSE` as `LICENSE.electron.txt` and the notices of Chromium and all its third-party components",
    'as `LICENSES.chromium.html` next to the executable.', '',
    `### electron ${pkg.version}`, '', `License: ${pkg.license} · ${urlOf(pkg)}`, '',
    'LICENSE:', '', fence(readFileSync(join(electron, 'LICENSE'), 'utf8')), ''].join('\n');
}

/** Crates linked into the mobile app for `target`: reached from the app through normal dependencies. */
function crates(target) {
  const r = spawnSync('cargo', ['metadata', '--format-version', '1', '--locked', '--manifest-path',
    join(root, 'apps/mobile/src-tauri/Cargo.toml'), '--filter-platform', target], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`cargo metadata failed for ${target}:\n${r.stderr}`);
  const meta = JSON.parse(r.stdout);
  const byId = new Map(meta.packages.map(p => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map(n => [n.id, n]));
  const reached = new Set();
  const stack = [meta.resolve.root];
  while (stack.length) {
    const id = stack.pop();
    if (reached.has(id)) continue;
    reached.add(id);
    for (const d of nodes.get(id).deps) if (d.dep_kinds.some(k => k.kind === null)) stack.push(d.pkg);
  }
  reached.delete(meta.resolve.root);
  return [...reached].map(id => byId.get(id));
}

const normLicense = l => (l || '(none: see license_file)').replace(/\s*\/\s*/g, ' OR ');
/** Licenses that are fine in an MIT app as long as their notices are kept. */
const PERMISSIVE = /^(MIT|Apache-2\.0|Apache-2\.0 WITH LLVM-exception|BSD-[23]-Clause|ISC|Zlib|Unicode-3\.0|Unicode-DFS-2016|0BSD|BSL-1\.0|CC0-1\.0|Unlicense|MIT-0|CDLA-Permissive-2\.0)$/;
const permissive = expr => expr.replace(/[()]/g, '').split(/ OR /).some(alt => alt.split(/ AND /).every(x => PERMISSIVE.test(x.trim())));

const TARGETS = { Android: 'aarch64-linux-android', iOS: 'aarch64-apple-ios' };

function rustPart() {
  const names = Object.keys(TARGETS);
  const sets = Object.fromEntries(Object.entries(TARGETS).map(([k, t]) => [k, crates(t)]));
  const counts = new Map();
  for (const [k, list] of Object.entries(sets)) {
    for (const c of list) {
      const l = normLicense(c.license);
      if (!counts.has(l)) counts.set(l, Object.fromEntries(names.map(n => [n, 0])));
      counts.get(l)[k]++;
    }
  }
  const total = n => names.reduce((sum, k) => sum + n[k], 0);
  const all = [...new Map(Object.values(sets).flat().map(c => [c.id, c])).values()];
  const odd = all.filter(c => !permissive(normLicense(c.license)));
  const notices = all.filter(c => readdirSync(dirname(c.manifest_path)).some(f => /^notice/i.test(f)));
  const out = ['## Mobile (Tauri 2 crates)', '',
    'Generated by `pnpm notices --rust` (`cargo metadata --locked --filter-platform <target>` on',
    '`apps/mobile/src-tauri`, crates reached through normal dependencies; build-only crates are not counted).',
    `Crates: ${names.map(k => `${sets[k].length} for ${k} (${TARGETS[k]})`).join(', ')}.`,
    'Each crate\'s license text is in its source (`cargo metadata` lists `manifest_path`); a release build of',
    'the mobile app should bundle them with a tool such as `cargo about generate`.', '',
    `| License | ${names.join(' | ')} |`, `|---|${names.map(() => '---|').join('')}`,
    ...[...counts.entries()].sort((a, b) => total(b[1]) - total(a[1]) || a[0].localeCompare(b[0]))
      .map(([l, n]) => `| ${l} | ${names.map(k => n[k]).join(' | ')} |`), ''];
  out.push(odd.length
    ? `Crates without a permissive option: ${odd.map(c => `${c.name} ${c.version} (${normLicense(c.license)})`).join(', ')}.`
    : 'Every crate has a permissive license option (MIT, Apache-2.0, BSD, ISC, Zlib, Unicode, …); none is copyleft-only.');
  out.push('', notices.length
    ? `Crates with a NOTICE file (keep it when shipping under Apache-2.0): ${notices.map(c => `${c.name} ${c.version}`).join(', ')}.`
    : 'No crate ships a NOTICE file.', '');
  return out.join('\n');
}

function replacePart(text, name, body) {
  const begin = `<!-- BEGIN GENERATED: ${name} -->`;
  const end = `<!-- END GENERATED: ${name} -->`;
  const block = `${begin}\n${body.trimEnd()}\n${end}`;
  const i = text.indexOf(begin);
  const j = text.indexOf(end);
  if (i < 0 || j < i) return `${text.trimEnd()}\n\n${block}\n`;
  return text.slice(0, i) + block + text.slice(j + end.length);
}

const current = existsSync(NOTICES) ? readFileSync(NOTICES, 'utf8') : '# Third-party notices\n';
let next = replacePart(current, 'js', jsPart());
next = replacePart(next, 'desktop', desktopPart());
if (args.includes('--check')) {
  if (next !== current) {
    console.error('THIRD_PARTY_NOTICES.md is out of date; run: pnpm notices');
    process.exit(1);
  }
  console.log('THIRD_PARTY_NOTICES.md is up to date');
} else {
  if (args.includes('--rust')) next = replacePart(next, 'rust', rustPart());
  writeFileSync(NOTICES, next);
  console.log(`wrote ${NOTICES}`);
}
