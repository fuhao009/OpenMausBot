export const COMPANION_RELAY_PATH = "/v1/companion/relay";

export const FRAME = Object.freeze({ OPEN: 0, DATA: 1, END: 2, RESET: 3 });
const FRAME_HEADER = 9;
const MAX_FRAME = 64 * 1024;
const MAX_BUFFER = 1024 * 1024;

export function encodeFrame(streamId, type, payload = Buffer.alloc(0)) {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
    throw new Error("invalid stream id");
  }
  if (!Number.isInteger(type) || type < 0 || type > 255) throw new Error("invalid frame type");
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > MAX_FRAME) throw new Error("frame too large");
  const header = Buffer.alloc(FRAME_HEADER);
  header.writeUInt32BE(streamId, 0);
  header.writeUInt8(type, 4);
  header.writeUInt32BE(body.length, 5);
  return Buffer.concat([header, body]);
}

export function createFrameDecoder() {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.length + incoming.length > MAX_BUFFER) {
        throw new Error("relay buffer exceeded");
      }
      buffer = buffer.length === 0 ? incoming : Buffer.concat([buffer, incoming]);
      const frames = [];
      while (buffer.length >= FRAME_HEADER) {
        const length = buffer.readUInt32BE(5);
        if (length > MAX_FRAME) throw new Error("frame too large");
        if (buffer.length < FRAME_HEADER + length) break;
        const streamId = buffer.readUInt32BE(0);
        const type = buffer.readUInt8(4);
        const payload = buffer.subarray(FRAME_HEADER, FRAME_HEADER + length);
        buffer = buffer.subarray(FRAME_HEADER + length);
        frames.push({ streamId, type, payload: Buffer.from(payload) });
      }
      return frames;
    },
    reset() {
      buffer = Buffer.alloc(0);
    },
  };
}
