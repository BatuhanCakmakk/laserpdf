// Copies runtime assets from node_modules into public/ before dev/build.
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pub = join(root, "public");
const nm = join(root, "node_modules");

for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  const src = join(nm, "pdfjs-dist", dir);
  if (existsSync(src)) cpSync(src, join(pub, "pdfjs", dir), { recursive: true });
}

const fonts = [
  "DejaVuSans", "DejaVuSans-Bold", "DejaVuSans-Oblique", "DejaVuSans-BoldOblique",
  "DejaVuSerif", "DejaVuSerif-Bold", "DejaVuSerif-Italic", "DejaVuSerif-BoldItalic",
  "DejaVuSansMono", "DejaVuSansMono-Bold", "DejaVuSansMono-Oblique", "DejaVuSansMono-BoldOblique",
];
mkdirSync(join(pub, "fonts"), { recursive: true });
for (const f of fonts) cpSync(join(nm, "dejavu-fonts-ttf", "ttf", `${f}.ttf`), join(pub, "fonts", `${f}.ttf`));
cpSync(join(nm, "dejavu-fonts-ttf", "LICENSE"), join(pub, "fonts", "LICENSE-DejaVu.txt"));

// Arimo, Tinos and Cousine: metric-compatible with Arial, Times New Roman and Courier New.
// Carlito matches Calibri; Caladea is close to Cambria.
const styles = { Regular: "400Regular", Bold: "700Bold", Italic: "400Regular_Italic", BoldItalic: "700Bold_Italic" };
for (const fam of ["Arimo", "Tinos", "Cousine", "Carlito", "Caladea"]) {
  const pkg = join(nm, "@expo-google-fonts", fam.toLowerCase());
  for (const [style, dir] of Object.entries(styles)) {
    cpSync(join(pkg, dir, `${fam}_${dir}.ttf`), join(pub, "fonts", `${fam}-${style}.ttf`));
  }
}
writeFileSync(
  join(pub, "fonts", "LICENSE-Arimo-Tinos-Cousine.txt"),
  ["arimo", "tinos", "cousine"].map((f) => readFileSync(join(nm, "@expo-google-fonts", f, "LICENSE_FONT"), "utf8")).join("\n\n"),
);
writeFileSync(
  join(pub, "fonts", "LICENSE-Carlito-Caladea.txt"),
  ["carlito", "caladea"].map((f) => readFileSync(join(nm, "@expo-google-fonts", f, "LICENSE_FONT"), "utf8")).join("\n\n"),
);

// Noto Sans CJK fallbacks for Chinese, Japanese and Korean text.
for (const s of ["JP", "SC", "KR"]) {
  const pkg = join(nm, "@expo-google-fonts", `noto-sans-${s.toLowerCase()}`);
  cpSync(join(pkg, "400Regular", `NotoSans${s}_400Regular.ttf`), join(pub, "fonts", `NotoSans${s}-Regular.ttf`));
  cpSync(join(pkg, "700Bold", `NotoSans${s}_700Bold.ttf`), join(pub, "fonts", `NotoSans${s}-Bold.ttf`));
}
cpSync(join(nm, "@expo-google-fonts", "noto-sans-jp", "LICENSE_FONT"), join(pub, "fonts", "LICENSE-Noto.txt"));
// Text recognition (OCR), fully offline: Tesseract worker, its SIMD + LSTM WebAssembly build,
// and the Turkish and English models. Worker and core sit in one folder, as the core finds
// its .wasm next to the worker script.
const ocr = join(pub, "tesseract");
mkdirSync(join(ocr, "lang"), { recursive: true });
cpSync(join(nm, "tesseract.js", "dist", "worker.min.js"), join(ocr, "worker.min.js"));
for (const f of ["tesseract-core-simd-lstm.js", "tesseract-core-simd-lstm.wasm"]) cpSync(join(nm, "tesseract.js-core", f), join(ocr, f));
for (const l of ["eng", "tur"]) {
  cpSync(join(nm, "@tesseract.js-data", l, "4.0.0_best_int", `${l}.traineddata.gz`), join(ocr, "lang", `${l}.traineddata.gz`));
}
writeFileSync(
  join(ocr, "LICENSE-Tesseract.txt"),
  [join(nm, "tesseract.js", "LICENSE.md"), join(nm, "tesseract.js-core", "LICENSE")].filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n\n"),
);

console.log("assets copied");
