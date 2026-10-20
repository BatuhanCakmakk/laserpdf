import {
  createElement,
  type IconNode,
  FolderOpen, Save, SaveAll, Printer, Undo2, Redo2, MousePointer2, Hand, TextCursorInput, Type,
  ImagePlus, Signature, Pencil, Brush, Highlighter, Underline, Strikethrough, Square, Circle, Minus,
  MoveUpRight, Eraser, StickyNote, Stamp, Shapes, ZoomIn, ZoomOut, ChevronLeft, ChevronRight, ChevronDown,
  ChevronUp, Ellipsis, Search, X, Plus, FileText, FilePlus, Files, Trash2, RotateCw, RotateCcw, Copy,
  BringToFront, SendToBack, Sun, Moon, Languages, Keyboard, Info, CircleAlert, Check, LayoutGrid,
  PanelLeft, Bookmark, Download, FileImage, Merge, Scissors, Hash, Droplets, Bold, Italic, AlignLeft,
  AlignCenter, AlignRight, PaintBucket, SquareDashed, MoveHorizontal, Maximize, Upload, FilePlus2,
  FileOutput, Minimize2, Images, CopyPlus, Wrench, ArrowUpDown, Lock, PenLine, CaseSensitive, Clock,
  Monitor, ListTree, Layers, ScanText, FileSpreadsheet, Crop, Link, BookOpen, BookmarkPlus, ArrowUp, ArrowDown,
  ListIndentIncrease, ListIndentDecrease, UserCheck, History, BookOpenText, Expand, Shrink, Palette,
} from "lucide";

const ICONS: Record<string, IconNode> = {
  open: FolderOpen, save: Save, saveAs: SaveAll, print: Printer, undo: Undo2, redo: Redo2,
  select: MousePointer2, hand: Hand, edittext: TextCursorInput, text: Type, image: ImagePlus,
  signature: Signature, draw: Pencil, highlighter: Brush, highlight: Highlighter, underline: Underline,
  strike: Strikethrough, rect: Square, ellipse: Circle, line: Minus, arrow: MoveUpRight, whiteout: Eraser,
  note: StickyNote, stamp: Stamp, shapes: Shapes, zoomIn: ZoomIn, zoomOut: ZoomOut, left: ChevronLeft,
  right: ChevronRight, down: ChevronDown, up: ChevronUp, more: Ellipsis, search: Search, x: X, plus: Plus,
  file: FileText, filePlus: FilePlus, files: Files, trash: Trash2, rotateCw: RotateCw, rotateCcw: RotateCcw,
  copy: Copy, front: BringToFront, back: SendToBack, sun: Sun, moon: Moon, languages: Languages,
  keyboard: Keyboard, info: Info, alert: CircleAlert, check: Check, grid: LayoutGrid, panel: PanelLeft,
  bookmark: Bookmark, download: Download, fileImage: FileImage, merge: Merge, split: Scissors, hash: Hash,
  watermark: Droplets, bold: Bold, italic: Italic, alignLeft: AlignLeft, alignCenter: AlignCenter,
  alignRight: AlignRight, fill: PaintBucket, border: SquareDashed, fitWidth: MoveHorizontal, fitPage: Maximize,
  upload: Upload, blankPage: FilePlus2, extract: FileOutput, compress: Minimize2, images: Images,
  duplicate: CopyPlus, tools: Wrench, reorder: ArrowUpDown, lock: Lock, pen: PenLine, font: CaseSensitive,
  clock: Clock, monitor: Monitor, outline: ListTree, layers: Layers, ocr: ScanText, sheet: FileSpreadsheet,
  crop: Crop, link: Link, booklet: BookOpen, bookmarkPlus: BookmarkPlus, arrowUp: ArrowUp, arrowDown: ArrowDown,
  indent: ListIndentIncrease, outdent: ListIndentDecrease, userStamp: UserCheck, history: History,
  reading: BookOpenText, expand: Expand, shrink: Shrink, palette: Palette,
};

/** A table over an "XLSX" label: says what the export makes. */
function xlsxIcon(size: number): SVGElement {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("width", String(size));
  s.setAttribute("height", String(size));
  s.setAttribute("viewBox", "0 0 24 24");
  s.classList.add("icon");
  s.innerHTML =
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">' +
    '<rect x="4" y="2" width="16" height="10" rx="1.5"/><path d="M4 7h16M10 2v10M15 2v10"/></g>' +
    '<text x="12" y="21.6" text-anchor="middle" fill="currentColor" font-size="8" font-weight="700" ' +
    'font-family="Segoe UI, Arial, sans-serif" letter-spacing="-0.3">XLSX</text>';
  return s;
}

export function icon(name: string, size = 18): SVGElement {
  if (name === "xlsx") return xlsxIcon(size);
  if (name === "blank") {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("width", String(size));
    s.setAttribute("height", String(size));
    s.classList.add("icon");
    return s;
  }
  const node = ICONS[name] ?? Info;
  const el = createElement(node);
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("stroke-width", "1.8");
  el.classList.add("icon");
  return el as unknown as SVGElement;
}
