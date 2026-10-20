import type { PDFDocumentProxy } from "pdfjs-dist";

/** A PDF file the document's pages can come from. */
export interface Source {
  id: string;
  name: string;
  bytes: Uint8Array;
  pdf: PDFDocumentProxy;
  password?: string;
}

/**
 * One page of the edited document. Coordinates of everything on the page are
 * in PDF points, relative to the top-left corner of the *unrotated* page.
 */
export interface PageRef {
  id: string;
  /** Source id, or null for a blank page. */
  src: string | null;
  /** Page index in the source (0-based). */
  index: number;
  w: number;
  h: number;
  /** Bottom-left corner of the page's view box in PDF user space. */
  vx: number;
  vy: number;
  /** Rotation stored in the source file. */
  baseRot: number;
  /** Rotation added by the user (multiple of 90). */
  rot: number;
}

/** carlito and caladea: stand-ins for Calibri and Cambria, the fonts of most PDFs made with Word. */
export type FontFamily = "sans" | "serif" | "mono" | "carlito" | "caladea";
export type ShapeKind = "rect" | "ellipse" | "line" | "arrow";
export type MarkKind = "highlight" | "underline" | "strike";

interface ObjBase {
  id: string;
  page: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Clockwise rotation in degrees around the box centre. */
  rot: number;
  opacity: number;
}

export interface TextObj extends ObjBase {
  type: "text";
  text: string;
  font: FontFamily;
  bold: boolean;
  italic: boolean;
  size: number;
  color: string;
  align: "left" | "center" | "right";
  bg: string | null;
  border: string | null;
}

export interface ImageObj extends ObjBase {
  type: "image";
  asset: string;
}

export interface InkObj extends ObjBase {
  type: "ink";
  /** Strokes, points normalised to the box (0..1). */
  strokes: number[][];
  color: string;
  width: number;
  multiply: boolean;
}

export interface ShapeObj extends ObjBase {
  type: "shape";
  shape: ShapeKind;
  stroke: string | null;
  fill: string | null;
  width: number;
  /** For lines/arrows: start and end normalised to the box. */
  p?: [number, number, number, number];
  /** Covers original content (edit-text background); not selectable. */
  cover?: boolean;
  /** For edit-text covers: the original text. It is removed from the page when possible, and the cover is then not painted. */
  coverText?: string;
  /** Whiteout: the page content under it is removed from the file on save. */
  redact?: boolean;
}

export interface MarkObj extends ObjBase {
  type: "mark";
  kind: MarkKind;
  color: string;
}

export interface NoteObj extends ObjBase {
  type: "note";
  text: string;
  color: string;
}

/** A clickable area that opens a web address or goes to a page of the document. */
export interface LinkObj extends ObjBase {
  type: "link";
  url?: string;
  /** Target page id. */
  dest?: string;
}

export type Obj = TextObj | ImageObj | InkObj | ShapeObj | MarkObj | NoteObj | LinkObj;

/** A bookmark. */
export interface OutlineItem {
  id: string;
  title: string;
  /** Target page id; null when the page is gone or the bookmark opens a web address. */
  page: string | null;
  /** Vertical position on the target page in PDF user space, when known. */
  top?: number | null;
  url?: string;
  items: OutlineItem[];
}

export interface Asset {
  id: string;
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
  url: string;
  width: number;
  height: number;
}

export interface DocMeta {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  /** Remove hidden information (programs, dates, XMP, annotation authors, photo metadata) on save. */
  clean?: boolean;
}

let counter = 0;
export function uid(prefix = "id"): string {
  counter++;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Total clockwise rotation of a page as displayed. */
export function pageRotation(p: PageRef): number {
  return (((p.baseRot + p.rot) % 360) + 360) % 360;
}

/** Displayed (rotated) page size. */
export function displaySize(p: PageRef): { w: number; h: number } {
  const r = pageRotation(p);
  return r % 180 === 0 ? { w: p.w, h: p.h } : { w: p.h, h: p.w };
}
