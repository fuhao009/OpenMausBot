import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

// The packaged app ships electron/** and package.json only: no node_modules and nothing outside electron/.
const ROOT = resolve(process.env.PACKAGED_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const ELECTRON = join(ROOT, "electron");
const PARSED = /\.[cm]?js$/;

function isNodeBuiltin(specifier) {
  return specifier.startsWith("node:") || builtinModules.includes(specifier);
}

function stringArgument(node) {
  const [first] = node.arguments;
  return node.arguments.length === 1 && first && ts.isStringLiteralLike(first) ? first.text : null;
}

function insideFunction(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent) || ts.isClassLike(parent)) return true;
  }
  return false;
}

export function staticSpecifiers(file, text = readFileSync(file, "utf8")) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && !insideFunction(node)) {
      const callee = node.expression;
      const required = stringArgument(node);
      if (required !== null && ts.isIdentifier(callee) && callee.text === "require") specifiers.push(required);
      else if (required !== null && ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "createRequire") specifiers.push(required);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

export function packagedImportProblems(entry = join(ELECTRON, "main.mjs")) {
  const problems = [];
  const seen = new Set();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!PARSED.test(file)) continue;
    for (const specifier of staticSpecifiers(file)) {
      const from = relative(ROOT, file).split(sep).join("/");
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        if (target !== ELECTRON && !target.startsWith(ELECTRON + sep)) problems.push(`${from} imports "${specifier}", outside electron/`);
        else if (!existsSync(target) || !statSync(target).isFile()) problems.push(`${from} imports "${specifier}", which is not a file`);
        else pending.push(target);
      } else if (specifier !== "electron" && !isNodeBuiltin(specifier)) {
        problems.push(`${from} imports "${specifier}", which the packaged app has no node_modules for`);
      }
    }
  }
  return { problems, files: seen.size };
}

test("everything main.mjs loads at startup is inside electron/ or a Node or Electron built-in", () => {
  assert.ok(existsSync(join(ELECTRON, "main.mjs")), `no electron/main.mjs under ${ROOT}`);
  const { problems, files } = packagedImportProblems();
  assert.ok(files > 50, `only walked ${files} files`);
  assert.deepEqual(problems, []);
});

test("the walk reports a bare package and a path that leaves electron/", () => {
  const source = [
    'import { WebSocket } from "ws";',
    'import { thing } from "../scripts/local-gateway/companion-relay.mjs";',
    'import net from "node:net";',
    'export * from "./sibling.mjs";',
    'const lazy = () => import("@trycua/cua-driver");',
    'const inner = () => require("later");',
    'const early = createRequire(import.meta.url)("./vendor/ws.cjs");',
  ].join("\n");
  assert.deepEqual(staticSpecifiers("x.mjs", source), ["ws", "../scripts/local-gateway/companion-relay.mjs", "node:net", "./sibling.mjs", "./vendor/ws.cjs"]);
  assert.deepEqual(staticSpecifiers("x.cjs", 'const { app } = require("electron");\nfunction later() { return require("nope"); }'), ["electron"]);
});
