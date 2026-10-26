/* Inkslide web - which of PDF.js's data files the build ships (pdfjs/ in dist)
 *
 * Shared by vite.config.ts (which copies them) and scripts/notices.mjs (which
 * lists their licenses), so the notices follow what ships. Plain JS: the
 * notices script runs in Node without a TypeScript loader.
 */

/** Folders of pdfjs-dist copied to dist/pdfjs/: CMaps, standard fonts, wasm decoders, ICC profiles. */
export const PDFJS_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

/** Left out (path relative to pdfjs-dist): the QuickJS build of the scripting sandbox, which Inkslide never loads. */
export const PDFJS_SKIP = /^wasm\/quickjs-eval\./;
