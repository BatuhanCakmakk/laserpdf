// Font subsetting with HarfBuzz (harfbuzz-subset.wasm).
// pdf-lib's own subsetter garbles the glyphs of the bundled fonts, so they are cut down here
// first and then embedded whole: a few characters instead of the full font.
import subsetWasmUrl from "harfbuzzjs/dist/harfbuzz-subset.wasm?url";

interface HbSubset {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
  hb_blob_create(data: number, length: number, mode: number, userData: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, lengthPtr: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, codepoint: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_or_fail(face: number, input: number): number;
}

let hbPromise: Promise<HbSubset> | null = null;
function harfbuzz(): Promise<HbSubset> {
  hbPromise ??= fetch(subsetWasmUrl)
    .then((r) => r.arrayBuffer())
    .then((bytes) => WebAssembly.instantiate(bytes, {}))
    .then(({ instance }) => instance.exports as unknown as HbSubset);
  return hbPromise;
}

/** Returns a copy of the TrueType font that only contains the given characters. */
export async function subsetFont(font: ArrayBuffer, codepoints: Iterable<number>): Promise<Uint8Array> {
  const hb = await harfbuzz();
  const src = new Uint8Array(font);
  const ptr = hb.malloc(src.byteLength);
  new Uint8Array(hb.memory.buffer).set(src, ptr);
  const HB_MEMORY_MODE_WRITABLE = 2;
  const blob = hb.hb_blob_create(ptr, src.byteLength, HB_MEMORY_MODE_WRITABLE, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);
  const input = hb.hb_subset_input_create_or_fail();
  const unicodes = hb.hb_subset_input_unicode_set(input);
  for (const cp of codepoints) hb.hb_set_add(unicodes, cp);
  const subset = hb.hb_subset_or_fail(face, input);
  hb.hb_subset_input_destroy(input);
  hb.hb_face_destroy(face);
  hb.free(ptr);
  if (!subset) throw new Error("font subsetting failed");
  const result = hb.hb_face_reference_blob(subset);
  const data = hb.hb_blob_get_data(result, 0);
  const length = hb.hb_blob_get_length(result);
  // Copy out before freeing: the wasm memory belongs to HarfBuzz.
  const out = new Uint8Array(hb.memory.buffer, data, length).slice();
  hb.hb_blob_destroy(result);
  hb.hb_face_destroy(subset);
  return out;
}
