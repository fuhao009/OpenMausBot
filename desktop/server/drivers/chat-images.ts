import { readFileSync, statSync } from "node:fs";
import type { SendTurnInput } from "../contracts.ts";

export interface ChatImagePart { type: "image_url"; image_url: { url: string } }
export interface ChatTextPart { type: "text"; text: string }
export type ChatContentPart = ChatTextPart | ChatImagePart;
const IMAGE_BYTES = 20 * 1024 * 1024;
const MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const CHAT_IMAGE_BUDGET = 32 * 1024 * 1024;

function imageBytes(parts: string | ChatContentPart[] | null): number {
  return Array.isArray(parts) ? parts.reduce((total, part) => total + (part.type === "image_url" ? part.image_url.url.length : 0), 0) : 0;
}

type ChatImageBudget = (parts: string | ChatContentPart[] | null, released?: ChatContentPart[]) => void;

/** Check a replacement before releasing anything, so a failed image keeps the last usable view. */
export function chatImageBudget(): ChatImageBudget {
  let used = 0;
  return (parts: string | ChatContentPart[] | null, released: ChatContentPart[] = []) => {
    const next = used + imageBytes(parts) - imageBytes(released);
    if (next > CHAT_IMAGE_BUDGET) throw new Error("Turn image budget exceeded (32 MiB encoded); screenshot cannot be retained. An operation may already have taken effect; inspect its state before retrying.");
    used = next;
  };
}

/** Only tool-generated batches enter this history; initial user attachments are never evicted. */
export function chatToolImageHistory(retain: ChatImageBudget) {
  const batches: ChatContentPart[][] = [];
  return (batch: ChatContentPart[], incoming: ChatContentPart[]) => {
    const fresh = batches.at(-1) !== batch;
    const oldest = fresh && batches.length === 2 ? batches[0] : undefined;
    retain(incoming, oldest);
    if (oldest) {
      for (let index = 0; index < oldest.length; index++) {
        if (oldest[index].type === "image_url") oldest[index] = { type: "text", text: "[Older tool screenshot omitted; the two most recent screenshot batches are retained.]" };
      }
      batches.shift();
    }
    if (fresh) batches.push(batch);
    batch.push(...incoming);
  };
}

export function assertImageTransport(url: string) {
  const endpoint = new URL(url);
  const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("Images and computer tools require HTTPS for remote API endpoints; HTTP is supported only on loopback.");
  }
}

export function chatImage(item: { mimeType?: unknown; data?: unknown }): ChatImagePart {
  const { mimeType, data } = item;
  if (typeof mimeType !== "string" || !MIME.has(mimeType) || typeof data !== "string" ||
      !data.length || data.length > Math.ceil(IMAGE_BYTES / 3) * 4 || data.length % 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error("Invalid or oversized MCP image");
  }
  const bytes = Buffer.from(data, "base64");
  const matches = mimeType === "image/png" ? bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) && bytes.toString("ascii", 12, 16) === "IHDR"
    : mimeType === "image/jpeg" ? bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mimeType === "image/gif" ? bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))
    : bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (bytes.length > IMAGE_BYTES || bytes.toString("base64") !== data || !matches) throw new Error("Image bytes do not match the declared MIME type");
  return { type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } };
}

export function chatUserContent(turn: SendTurnInput): string | ChatContentPart[] {
  if (!turn.images?.length) return turn.text;
  const budget = chatImageBudget();
  return [{ type: "text", text: turn.text }, ...turn.images.map(image => {
    if (statSync(image.path).size > IMAGE_BYTES) throw new Error("Image exceeds 20 MB");
    const part = chatImage({ mimeType: image.mime, data: readFileSync(image.path).toString("base64") });
    budget([part]);
    return part;
  })];
}

export function chatToolImages(callId: string, images?: ChatImagePart[]): ChatContentPart[] {
  return images?.length ? [{ type: "text", text: `Screenshot result from tool call ${callId}:` }, ...images] : [];
}
