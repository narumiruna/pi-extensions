import { Resvg } from "@resvg/resvg-js";
import { render } from "pele";
import { checkPixels, LIMITS } from "./render-limits.mjs";
import { normalizeSvg, PALETTES } from "./svg-normalization.mjs";

if (!process.send) throw new Error("Diagram worker requires a parent IPC channel.");
/** @param {object} message */
function send(message) {
  process.send?.(message, (error) => {
    if (error) process.exit(1);
  });
}
process.once("disconnect", () => process.exit(0));
process.once(
  "message",
  (
    /** @type {{operation:'layout',source:string,kind:'svg'|'mermaid'}|{operation:'raster',layout:import('./rasterizer.js').DiagramLayout,appearance:'dark'|'light',widthPx:number}} */ request,
  ) => {
    try {
      if (request.operation === "layout") {
        if (request.source.length > LIMITS.sourceChars) throw new Error("Diagram source limit exceeded.");
        const svg =
          request.kind === "mermaid"
            ? render(request.source, {
                limit: LIMITS.sourceChars,
                outputLimit: LIMITS.svgBytes,
                maxEdges: LIMITS.maxEdges,
                responsive: false,
                autoDirection: false,
                links: false,
                images: false,
              }).svg
            : request.source;
        send({ type: "result", value: normalizeSvg(svg, request.kind) });
      } else {
        const layout = normalizeSvg(request.layout.svg, request.layout.kind, request.appearance);
        if (layout.width !== request.layout.width || layout.height !== request.layout.height)
          throw new Error("SVG geometry does not match its layout record.");
        const height = Math.max(1, Math.round((request.widthPx * layout.height) / layout.width));
        checkPixels(request.widthPx, height);
        const renderer = new Resvg(layout.svg, {
          fitTo: { mode: "width", value: request.widthPx },
          font: { loadSystemFonts: true, defaultFontFamily: "sans-serif" },
          ...(layout.kind === "mermaid" ? { background: PALETTES[request.appearance]["--pele-bg"] } : {}),
          logLevel: "off",
        });
        if (renderer.imagesToResolve().length) throw new Error("SVG external images are not supported.");
        const image = renderer.render();
        checkPixels(image.width, image.height);
        const png = image.asPng();
        if (png.byteLength > LIMITS.pngBytes) throw new Error("PNG exceeds the 4 MiB limit.");
        send({
          type: "result",
          value: { png: png.toString("base64"), width: image.width, height: image.height },
        });
      }
    } catch (error) {
      // The parent strips terminal controls at the display boundary and bounds this diagnostic again.
      send({
        type: "error",
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      });
    }
  },
);
// Work deadlines begin only after all runtime imports have completed.
send({ type: "ready" });
