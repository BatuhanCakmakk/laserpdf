// WebKit (the system webview on Linux and macOS) cannot iterate a ReadableStream with `for await` yet.
// pdf.js reads text content and inflates data that way, so text extraction and search fail there without this.
const proto = ReadableStream.prototype as unknown as Record<PropertyKey, unknown>;
if (typeof proto[Symbol.asyncIterator] !== "function") {
  proto.values = async function* (this: ReadableStream, { preventCancel = false } = {}) {
    const reader = this.getReader();
    let done = false;
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) {
          done = true;
          return;
        }
        yield r.value;
      }
    } finally {
      // Leaving the loop early cancels the stream, as the built-in iterator does.
      if (!done && !preventCancel) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
  proto[Symbol.asyncIterator] = proto.values;
}

export {};
