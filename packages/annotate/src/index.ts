/* @inkslide/annotate - public entry point.
 * Each module is also importable on its own (e.g. '@inkslide/annotate/geometry').
 * The stylesheet is '@inkslide/annotate/toolbar.css'.
 */
export * as geometry from './geometry';
export * as model from './model';
export * as render from './render';
export * as input from './input';
export * as tools from './tools';
export * as toolbar from './toolbar';
export * as pages from './pages';
export * as io from './io';
export * as clipboard from './clipboard';
export * as color from './color';
export * as app from './app';

export type { Point, Vec2, XY, Stroke, StrokeTool, BBox, OutlineEngine, RectLike } from './geometry';
export { NotesDoc, History, createStroke, createImage } from './model';
export type { Deck, DeckInit, Page, SlidePage, BlankPage, PageImage, Paper, Size, Command, NotesJSON } from './model';
export type { Layer, Laser } from './render';
export type { Surface, Tool, ToolId, Tools, Prefs, Selection, ToolHost, ToolPreview, ToolSync } from './tools';
export type { InputHost, InputController, PenButton } from './input';
export type { ToolbarHost, ToolbarGroup, ToolbarItem, Shortcut, Toolbar } from './toolbar';
export type { PagesController, PagesHost } from './pages';
export type { PlatformAdapter, PdfFile, PdfInfo, LoadResult, NotesBackup } from './io';
export type { Clip } from './clipboard';
export { createAnnotator } from './app';
export type { Annotator, AnnotatorOptions, Capture } from './app';
export { createAutosave, type Autosave, type AutosaveOptions, type AutosaveState } from './autosave';
