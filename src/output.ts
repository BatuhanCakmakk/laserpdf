import { PDFDocument } from "pdf-lib";
import { loadPdf } from "./engine";
import { printWindow } from "./platform";

let printUrls: string[] = [];

/** Renders every page of a PDF to image blobs at the given resolution. */
export async function renderPdfToImages(
  bytes: Uint8Array,
  dpi: number,
  type: "image/png" | "image/jpeg",
  quality = 0.9,
  onPage?: (i: number, n: number) => void,
  only?: number[],
): Promise<{ blob: Blob; width: number; height: number; wPt: number; hPt: number }[]> {
  const { pdf } = await loadPdf(bytes);
  const out: { blob: Blob; width: number; height: number; wPt: number; hPt: number }[] = [];
  try {
    const list = only ?? Array.from({ length: pdf.numPages }, (_, i) => i);
    for (let k = 0; k < list.length; k++) {
      onPage?.(k, list.length);
      const page = await pdf.getPage(list[k] + 1);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: dpi / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport: vp, background: "#ffffff" }).promise;
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), type, quality));
      out.push({ blob, width: canvas.width, height: canvas.height, wPt: base.width, hPt: base.height });
      canvas.width = canvas.height = 0;
      page.cleanup();
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
  return out;
}

/** Rebuilds a PDF from JPEG renders of its pages. */
export async function rasterizePdf(bytes: Uint8Array, dpi: number, quality: number, onPage?: (i: number, n: number) => void): Promise<Uint8Array> {
  const imgs = await renderPdfToImages(bytes, dpi, "image/jpeg", quality, onPage);
  const out = await PDFDocument.create();
  for (const im of imgs) {
    const jpg = await out.embedJpg(new Uint8Array(await im.blob.arrayBuffer()));
    const page = out.addPage([im.wPt, im.hPt]);
    page.drawImage(jpg, { x: 0, y: 0, width: im.wPt, height: im.hPt });
  }
  return out.save({ useObjectStreams: true });
}

/** Prints by rendering pages to images in a print-only container. */
export async function printPdf(bytes: Uint8Array, onPage?: (i: number, n: number) => void): Promise<void> {
  const imgs = await renderPdfToImages(bytes, 150, "image/jpeg", 0.92, onPage);
  const root = document.getElementById("print-root")!;
  // The previous job's images are kept until now: native print dialogs may read them late.
  printUrls.forEach((u) => URL.revokeObjectURL(u));
  document.getElementById("print-page-style")?.remove();
  const urls = (printUrls = imgs.map((im) => URL.createObjectURL(im.blob)));
  root.replaceChildren(
    ...imgs.map((im, i) => {
      const img = document.createElement("img");
      img.src = urls[i];
      img.className = im.wPt > im.hPt ? "landscape" : "portrait";
      return img;
    }),
  );
  await Promise.all(Array.from(root.querySelectorAll("img")).map((img) => img.decode().catch(() => {})));
  const style = document.createElement("style");
  style.id = "print-page-style";
  const landscape = imgs[0] && imgs[0].wPt > imgs[0].hPt;
  style.textContent = `@page { size: ${landscape ? "landscape" : "portrait"}; margin: 0; }`;
  document.head.append(style);
  // Only affects @media print, so it can stay on until the next print job.
  document.body.classList.add("printing");
  await printWindow();
}
