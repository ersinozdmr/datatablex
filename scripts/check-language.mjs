// Fails when a tracked file contains Turkish letters outside the allowlist.
//
// The codebase is written in English. Turkish text belongs in the Turkish
// locale and in the tests that cover Turkish-character handling; those files
// are listed in `scripts/language-allowlist.txt`.
//
// Usage: node scripts/check-language.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWLIST_PATH = "scripts/language-allowlist.txt";

// Listed by code point so that this file passes its own check: the lowercase and
// uppercase forms of c-cedilla, soft g, dotless i / dotted I, o-umlaut, s-cedilla and u-umlaut.
const TURKISH_CODE_POINTS = [
  0xe7, 0x11f, 0x131, 0xf6, 0x15f, 0xfc, 0xc7, 0x11e, 0x130, 0xd6, 0x15e, 0xdc,
];
const TURKISH_LETTERS = new RegExp(`[${String.fromCodePoint(...TURKISH_CODE_POINTS)}]`);

/** Turns an allowlist entry into a regular expression (`*` stays within a segment, `**` crosses segments). */
function toPattern(entry) {
  const source = entry
    .split(/(\*\*|\*)/)
    .map((part) => {
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`);
}

function readAllowlist() {
  return readFileSync(ALLOWLIST_PATH, "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map(toPattern);
}

function listFiles() {
  // Tracked files plus new files that are not ignored, so the check also covers work not yet committed.
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

const allowed = readAllowlist();
const findings = [];

for (const file of listFiles()) {
  if (allowed.some((pattern) => pattern.test(file))) continue;

  let content;
  try {
    content = readFileSync(file);
  } catch {
    // Listed by git but missing on disk (deleted and not yet staged).
    continue;
  }
  // A NUL byte in the first block marks a binary file.
  if (content.subarray(0, 8192).includes(0)) continue;

  content
    .toString("utf8")
    .split("\n")
    .forEach((line, index) => {
      const match = TURKISH_LETTERS.exec(line);
      if (match)
        findings.push(`${file}:${index + 1}:${match.index + 1}  ${line.trim().slice(0, 120)}`);
    });
}

if (findings.length > 0) {
  console.error(`Turkish letters found outside ${ALLOWLIST_PATH}:\n`);
  for (const finding of findings) console.error(`  ${finding}`);
  console.error(
    `\n${findings.length} line(s). Write the text in English, or add the file to the allowlist.`,
  );
  process.exit(1);
}

console.log("Language check passed.");
