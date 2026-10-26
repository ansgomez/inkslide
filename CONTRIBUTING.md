# Contributing

## Setup

Node.js 22.13 or newer and pnpm 9 (the repository pins 9.15.9); see
[docs/INSTALL.md](docs/INSTALL.md) for installing them on Fedora.

```sh
pnpm install
pnpm typecheck        # every package
pnpm test             # unit tests, every package
pnpm dev              # web dev server (http://localhost:5173) and the desktop app on it
```

The Tauri shell in `apps/mobile` also needs Rust 1.90+ and, on Linux, the WebKitGTK
development packages (Fedora: `sudo dnf install webkit2gtk4.1-devel openssl-devel
librsvg2-devel`); see [apps/mobile/README.md](apps/mobile/README.md).

## Code style

- **Match the surrounding code.** Most of `packages/annotate` is a port of the Marp Notes
  modules; keep their structure, names and behaviour unless a change is the point. Record
  behaviour changes in `packages/annotate/PORTING.md`.
- **Strict TypeScript** (`tsconfig.base.json`, `verbatimModuleSyntax`: use `import type`). Avoid `any`; prefer narrow types and
  `readonly` arrays for data that is not mutated. Strokes and page stroke arrays are
  immutable: replace them, never edit them in place.
- **File header.** Every source file starts with a block comment naming the package and the
  module's job (`/* Inkslide annotate - … */`), plus what the reader needs to know before the
  code: layout, invariants, the origin of ported code.
- **Comments are short and say why.** One-line TSDoc (`/** … */`) on every export; longer
  only when the behaviour is not obvious. No comments that repeat the code.
- **Naming:** `camelCase` functions and variables, `PascalCase` types and classes,
  `UPPER_CASE` constants. Factories are `createX()`, returning an interface `X`. Page ids are
  `p<n>` (PDF), `s<n>` (Marp) and `b-…` (blank).
- **Formatting:** 2 spaces, single quotes, semicolons, lines mostly under 120 characters. Short
  one-line helpers are fine; keep related code dense rather than spread out.
- **Layering:** `packages/annotate` has no PDF and no file system code; the pure modules
  (`geometry`, `model`, `io`, `autosave`, `pages`) do not touch the DOM. File access goes
  through the `PlatformAdapter`. The Electron main process does no rendering.
- **Errors the user sees** are plain sentences ("Could not open the PDF: …"). Never overwrite
  saved notes that could not be read without reading them again and asking; on the desktop,
  keep a copy of the unreadable file before replacing it.

## Tests

| What | Where | Command |
|---|---|---|
| Type check | every package | `pnpm typecheck` |
| Unit tests (Vitest; `node:test` in `apps/mobile`) | `packages/*/test`, `apps/*/test` | `pnpm test` |
| End-to-end (Playwright) | `apps/web/e2e` | `pnpm --filter @inkslide/web test:e2e` |
| Desktop smoke test | `apps/desktop/test/smoke.mjs` | `pnpm --filter @inkslide/desktop smoke` |
| Tauri shell (Linux) | `apps/mobile` | `pnpm --filter @inkslide/mobile check`, then `pnpm --filter @inkslide/web build:tauri && pnpm --filter @inkslide/mobile smoke` |

- Every bug fix comes with a test that fails without it.
- Keep `packages/annotate/test/legacy.test.ts` green: it checks the port against the
  original Marp Notes code.
- DOM code is tested with happy-dom (`// @vitest-environment happy-dom`); pointer and pen
  behaviour end to end with synthetic `PointerEvent`s (pressure, `pointerType`, buttons).
- The e2e tests build the app and run against `vite preview` on port 4173
  (`INKSLIDE_E2E_PORT` picks another, e.g. when two checkouts run tests at once). Install a
  browser once with `pnpm --filter @inkslide/web exec playwright install chromium`. WebKit:
  `INKSLIDE_E2E_WEBKIT=1`.
- A few tests also run on a large real PDF of your own when `INKSLIDE_FIXTURE_PDF` names
  one (export, hashing, page-turn timing); without it they are skipped.
- The smoke test launches Electron (a window may flash) and drives the real bridge: open from
  the command line, sidecar and app-storage notes, the notes backup and revert (also turned off
  and switched off), the unreadable copy, cleanup of old copies,
  refused paths and permissions, second
  instance, save on close, print (to a file), and on Linux a desktop entry launched by `gio`.
  It loads its own fixture page, so it does not need `apps/web/dist`.
- Scripts that install into the home directory (`install-dev-entry`) are tried with a temporary
  `HOME` and `XDG_DATA_HOME`, never against the real ones.

Run `pnpm typecheck` and `pnpm test` before every commit. CI (`.github/workflows/ci.yml`) runs them and the end-to-end tests on every push to `main` and every pull request.

The README's demo GIF is recorded by `pnpm demo` (`apps/web/scripts/record-demo.mjs`; needs
`ffmpeg`). Run it again after visible changes to the toolbar or the page.

## Commits

As in `git log`:

- Subject in the imperative, capitalized, no trailing period, about 50–70 characters, saying
  what changes for the user or the code: "Keep notes for pages the PDF no longer has".
- An area prefix when it helps: `Web:`, `Desktop:`.
- A body, wrapped at about 72 columns, explaining the problem and why the change fixes it.
- One logical change per commit; merges keep the branch history (`Merge review: …`).
- Commits written with Claude end with a `Co-Authored-By:` trailer.

## License

By contributing you agree that your work is licensed under the MIT license of the project.

## Releases

Set the new version in `package.json` and `apps/desktop/package.json`, commit, then push a tag
`v<version>` (for example `git tag v0.1.0 && git push origin v0.1.0`).
`.github/workflows/release.yml` builds the AppImage and RPM, the Windows installer and the macOS
DMGs and publishes them as a pre-release with `.github/release-notes.md`. Run the workflow by
hand (Actions → Release → Run workflow) to build the packages without publishing them.
