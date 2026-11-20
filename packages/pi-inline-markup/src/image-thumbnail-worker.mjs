import { parentPort, workerData } from "node:worker_threads";
import sharp from "sharp";

function matchesFormat(bytes, format) {
  switch (format) {
    case "png":
      return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    case "jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8;
    case "gif":
      return ["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6));
    case "webp":
      return bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP";
  }
}

const { bytes, format, maxWidth, maxHeight } = workerData;
const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
// Only pass the advertised image format to the decoder.
if (matchesFormat(input, format)) {
  const { data, info } = await sharp(input)
    .autoOrient()
    .resize({ width: maxWidth, height: maxHeight, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });
  parentPort.postMessage({ data: data.toString("base64"), widthPx: info.width, heightPx: info.height });
}
