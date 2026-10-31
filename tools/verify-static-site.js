import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(root, "public");
const requiredFiles = ["index.html", "styles.css", "404.html"];

for (const filename of requiredFiles) {
  const file = path.join(publicDir, filename);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Missing deployable static file: public/${filename}`);
  }
}

const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
for (const href of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
  const target = href[1];
  if (!target.startsWith("/") || target.startsWith("//")) continue;
  const pathname = target.split(/[?#]/, 1)[0];
  if (!pathname || pathname === "/") continue;
  const file = path.join(publicDir, pathname);
  if (!file.startsWith(`${publicDir}${path.sep}`) || !fs.existsSync(file)) {
    throw new Error(`Broken local asset reference in public/index.html: ${target}`);
  }
}

console.log("Static Vercel output verified: public/");
