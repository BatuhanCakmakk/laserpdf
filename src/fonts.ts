import type { FontFamily } from "./model";
import { lang } from "./i18n";

// Arimo, Tinos and Cousine have the same character widths as Arial/Helvetica, Times and Courier,
// the fonts most PDFs use, so edited text keeps the length of the original.
export const FONT_FILES: Record<FontFamily, [string, string, string, string]> = {
  // regular, bold, italic, bold-italic
  sans: ["Arimo-Regular", "Arimo-Bold", "Arimo-Italic", "Arimo-BoldItalic"],
  serif: ["Tinos-Regular", "Tinos-Bold", "Tinos-Italic", "Tinos-BoldItalic"],
  mono: ["Cousine-Regular", "Cousine-Bold", "Cousine-Italic", "Cousine-BoldItalic"],
  // Carlito has Calibri's widths; Caladea is close to Cambria (about 5% narrower).
  carlito: ["Carlito-Regular", "Carlito-Bold", "Carlito-Italic", "Carlito-BoldItalic"],
  caladea: ["Caladea-Regular", "Caladea-Bold", "Caladea-Italic", "Caladea-BoldItalic"],
};

/** DejaVu covers many more scripts and symbols; it fills in characters the main fonts lack. */
const FALLBACK_FILES: Record<FontFamily, [string, string, string, string]> = {
  sans: ["DejaVuSans", "DejaVuSans-Bold", "DejaVuSans-Oblique", "DejaVuSans-BoldOblique"],
  serif: ["DejaVuSerif", "DejaVuSerif-Bold", "DejaVuSerif-Italic", "DejaVuSerif-BoldItalic"],
  mono: ["DejaVuSansMono", "DejaVuSansMono-Bold", "DejaVuSansMono-Oblique", "DejaVuSansMono-BoldOblique"],
  carlito: ["DejaVuSans", "DejaVuSans-Bold", "DejaVuSans-Oblique", "DejaVuSans-BoldOblique"],
  caladea: ["DejaVuSerif", "DejaVuSerif-Bold", "DejaVuSerif-Italic", "DejaVuSerif-BoldItalic"],
};

const FAMILY_NAMES: Record<FontFamily, string> = {
  sans: "PS Sans", serif: "PS Serif", mono: "PS Mono", carlito: "PS Carlito", caladea: "PS Caladea",
};

export const CSS_FAMILY: Record<FontFamily, string> = {
  sans: "'PS Sans', 'PS Sans Fallback'",
  serif: "'PS Serif', 'PS Serif Fallback'",
  mono: "'PS Mono', 'PS Mono Fallback'",
  carlito: "'PS Carlito', 'PS Carlito Fallback'",
  caladea: "'PS Caladea', 'PS Caladea Fallback'",
};

export function fontFile(font: FontFamily, bold: boolean, italic: boolean): string {
  return FONT_FILES[font][(bold ? 1 : 0) + (italic ? 2 : 0)];
}

export function fallbackFontFile(font: FontFamily, bold: boolean, italic: boolean): string {
  return FALLBACK_FILES[font][(bold ? 1 : 0) + (italic ? 2 : 0)];
}

// None of the bundled Latin fonts has Chinese, Japanese or Korean glyphs; those fall back to Noto Sans.
export type CjkScript = "jp" | "sc" | "kr";

const CJK_FILES: Record<CjkScript, [string, string]> = {
  jp: ["NotoSansJP-Regular", "NotoSansJP-Bold"],
  sc: ["NotoSansSC-Regular", "NotoSansSC-Bold"],
  kr: ["NotoSansKR-Regular", "NotoSansKR-Bold"],
};

const CJK_CSS: Record<CjkScript, string> = { jp: "PS CJK JP", sc: "PS CJK SC", kr: "PS CJK KR" };

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const KANA = /[぀-ヿㇰ-ㇿ･-ﾟ]/;
const CJK = /[ᄀ-ᇿ⺀-⿟　-鿿가-힯豈-﫿︰-﹏＀-￯]|[\ud840-\ud87f][\udc00-\udfff]/;

export function hasCjk(text: string): boolean {
  return CJK.test(text);
}

/**
 * Fallback fonts for a text, most suitable first. Han characters look different
 * per region, so the text's own script decides, then the UI language.
 */
export function cjkOrder(text: string): CjkScript[] {
  const first: CjkScript = HANGUL.test(text) ? "kr" : KANA.test(text) ? "jp" : lang === "ja" ? "jp" : lang === "ko" ? "kr" : "sc";
  return [first, ...(["jp", "sc", "kr"] as const).filter((s) => s !== first)];
}

export function cjkFontFile(script: CjkScript, bold: boolean): string {
  return CJK_FILES[script][bold ? 1 : 0];
}

/** CSS font stack for a text object: the bundled font, then the CJK fallbacks in the same order as the PDF export. */
export function cssFamily(font: FontFamily, text: string): string {
  if (!hasCjk(text)) return CSS_FAMILY[font];
  return [CSS_FAMILY[font], ...cjkOrder(text).map((s) => `'${CJK_CSS[s]}'`)].join(", ");
}

/** Loads the fonts a text needs. Resolves to true if something had to be loaded. */
export async function loadFontsFor(font: FontFamily, bold: boolean, text: string): Promise<boolean> {
  if (!hasCjk(text)) return false;
  const spec = `${bold ? "bold " : ""}16px ${cssFamily(font, text)}`;
  if (document.fonts.check(spec, text)) return false;
  await document.fonts.load(spec, text).catch(() => []);
  return true;
}

/** Line height used for text objects, as a multiple of the font size. */
export const LINE_HEIGHT = 1.2;
/** Inner padding of text boxes in points. */
export const TEXT_PAD = 2;

/** Vertical metrics (in em) of the bundled fonts (hhea ascender/descender). */
export const METRICS: Record<FontFamily, { asc: number; desc: number }> = {
  sans: { asc: 0.905, desc: 0.212 },
  serif: { asc: 0.891, desc: 0.216 },
  mono: { asc: 0.833, desc: 0.3 },
  carlito: { asc: 0.952, desc: 0.269 },
  caladea: { asc: 0.9, desc: 0.25 },
};

/** Distance from the top of a text box to the first baseline, in points. */
export function firstBaseline(font: FontFamily, size: number): number {
  const m = METRICS[font];
  const lh = LINE_HEIGHT * size;
  return TEXT_PAD + (lh - (m.asc + m.desc) * size) / 2 + m.asc * size;
}

let fontsReady: Promise<void> | null = null;
/** Makes sure the editor fonts (and any CJK fallbacks the text needs) are loaded before measuring text. */
export async function ensureFonts(text = ""): Promise<void> {
  await baseFonts();
  if (hasCjk(text)) await Promise.all([loadFontsFor("sans", false, text), loadFontsFor("sans", true, text)]);
}

function baseFonts(): Promise<void> {
  if (!fontsReady) {
    const fams = Object.values(FAMILY_NAMES);
    fontsReady = Promise.all(
      fams.flatMap((f) => [
        document.fonts.load(`16px '${f}'`),
        document.fonts.load(`bold 16px '${f}'`),
        document.fonts.load(`italic 16px '${f}'`),
        document.fonts.load(`italic bold 16px '${f}'`),
      ]),
    ).then(() => undefined, () => undefined);
  }
  return fontsReady;
}

/** Declares the bundled fonts for the editor so text looks the same as in the saved PDF. */
function registerFontFaces(): void {
  const css: string[] = [];
  // The browser only downloads a fallback face when a character needs it.
  for (const [files, suffix] of [[FONT_FILES, ""], [FALLBACK_FILES, " Fallback"]] as const) {
    for (const fam of Object.keys(files) as FontFamily[]) {
      files[fam].forEach((file, i) => {
        const url = new URL(`./fonts/${file}.ttf`, document.baseURI).href;
        css.push(
          `@font-face{font-family:'${FAMILY_NAMES[fam]}${suffix}';src:url('${url}') format('truetype');font-weight:${i & 1 ? 700 : 400};font-style:${i & 2 ? "italic" : "normal"};font-display:block;}`,
        );
      });
    }
  }
  // Large CJK fonts load only when a text actually uses them.
  for (const s of Object.keys(CJK_FILES) as CjkScript[]) {
    CJK_FILES[s].forEach((file, i) => {
      const url = new URL(`./fonts/${file}.ttf`, document.baseURI).href;
      css.push(`@font-face{font-family:'${CJK_CSS[s]}';src:url('${url}') format('truetype');font-weight:${i ? 700 : 400};font-display:block;}`);
    });
  }
  const style = document.createElement("style");
  style.textContent = css.join("\n");
  document.head.append(style);
}

registerFontFaces();
