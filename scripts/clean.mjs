import { rm } from "node:fs/promises";

const generatedPaths = [
  "dist",
  "dist-electron",
  "dist-native",
  "dist-server",
  "release",
  "desktop/electron/resources/speech-helper",
  "desktop/electron/resources/Hezuo Speech.app",
];

await Promise.all(
  generatedPaths.map((path) => rm(path, { recursive: true, force: true })),
);
