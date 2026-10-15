const fs = require("node:fs");
const path = require("node:path");

const NUMBER = "(0|[1-9]\\d*)";
const OFFICIAL_VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);
const FORK_VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}-ruivza\\.([1-9]\\d*)$`);

function parseVersion(value, fork) {
  const match = typeof value === "string" && (fork ? FORK_VERSION : OFFICIAL_VERSION).exec(value);
  if (!match) {
    throw new Error(
      `Invalid ${fork ? "fork" : "official"} version: expected ${fork ? "X.Y.Z-ruivza.N (N >= 1)" : "X.Y.Z"}`
    );
  }
  const numbers = match.slice(1).map(Number);
  if (numbers.some((number) => !Number.isSafeInteger(number))) {
    throw new Error("Version components must be safe integers");
  }
  const [major, minor, patch, revision] = numbers;
  return fork ? { major, minor, patch, revision } : { major, minor, patch };
}

function parseOfficialVersion(value) {
  return parseVersion(value, false);
}

function parseForkVersion(value) {
  return parseVersion(value, true);
}

// Call only after the sync transaction has found new upstream commits.
function deriveNextVersion(forkVersion, upstreamVersion) {
  const fork = parseForkVersion(forkVersion);
  const upstream = parseOfficialVersion(upstreamVersion);
  const differing = ["major", "minor", "patch"].find((key) => fork[key] !== upstream[key]);
  if (differing && upstream[differing] < fork[differing]) {
    throw new Error("Upstream official version must not move the fork baseline backwards");
  }
  const revision = differing ? 1 : fork.revision + 1;
  if (!Number.isSafeInteger(revision)) throw new Error("Fork revision exceeds safe integer range");
  return `${upstreamVersion}-ruivza.${revision}`;
}

function validateMobileVersion(upstreamVersion, revision) {
  parseOfficialVersion(upstreamVersion);
  if (typeof revision !== "string")
    throw new Error("Mobile revision must be a positive integer string");
  return parseForkVersion(`${upstreamVersion}-ruivza.${revision}`);
}

// The caller invokes this only when the upstream update changes mobile files.
function deriveMobileVersion(forkMobileConfig, newOfficialVersion) {
  if (!forkMobileConfig || typeof forkMobileConfig !== "object") {
    throw new Error("Mobile fork version config must be an object");
  }
  const { upstreamVersion, revision } = forkMobileConfig;
  validateMobileVersion(upstreamVersion, revision);
  const next = parseForkVersion(
    deriveNextVersion(`${upstreamVersion}-ruivza.${revision}`, newOfficialVersion)
  );
  return { upstreamVersion: newOfficialVersion, revision: String(next.revision) };
}

function skipWhitespace(text, offset) {
  while (offset < text.length && /[ \t\r\n]/.test(text[offset])) offset++;
  return offset;
}

function stringEnd(text, offset) {
  for (let cursor = offset + 1; cursor < text.length; cursor++) {
    if (text[cursor] === "\\") cursor++;
    else if (text[cursor] === '"') return cursor + 1;
  }
  throw new Error("Unterminated JSON string");
}

// JSON.parse validates syntax first. This scanner only locates existing value
// spans, preserving every byte outside the selected version string literals.
function valueEnd(text, offset) {
  if (text[offset] === '"') return stringEnd(text, offset);
  if (text[offset] !== "{" && text[offset] !== "[") {
    let cursor = offset;
    while (cursor < text.length && !/[ \t\r\n,}\]]/.test(text[cursor])) cursor++;
    return cursor;
  }
  let depth = 0;
  let cursor = offset;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === '"') {
      cursor = stringEnd(text, cursor);
      continue;
    }
    if (character === "{" || character === "[") depth++;
    else if ((character === "}" || character === "]") && --depth === 0) return cursor + 1;
    cursor++;
  }
  throw new Error("Unterminated JSON value");
}

function propertySpan(text, objectOffset, key, label) {
  if (text[objectOffset] !== "{") throw new Error(`${label}: expected a JSON object`);
  let cursor = skipWhitespace(text, objectOffset + 1);
  let found;
  while (text[cursor] !== "}") {
    const end = stringEnd(text, cursor);
    const property = JSON.parse(text.slice(cursor, end));
    const start = skipWhitespace(text, skipWhitespace(text, end) + 1);
    const stop = valueEnd(text, start);
    if (property === key) {
      if (found) throw new Error(`${label}: duplicate property`);
      found = { start, end: stop };
    }
    cursor = skipWhitespace(text, stop);
    if (text[cursor] === ",") cursor = skipWhitespace(text, cursor + 1);
  }
  if (!found) throw new Error(`${label}: missing property`);
  return found;
}

function replaceMetadata(text, replacements, filename) {
  try {
    JSON.parse(text);
  } catch (error) {
    throw new SyntaxError(`${filename}: invalid JSON: ${error.message}`, { cause: error });
  }
  const edits = replacements.map(({ keys, value }) => {
    let span = { start: skipWhitespace(text, 0) };
    for (let index = 0; index < keys.length; index++) {
      const label = `${filename} ${JSON.stringify(keys.slice(0, index + 1))}`;
      span = propertySpan(text, span.start, keys[index], label);
    }
    if (typeof JSON.parse(text.slice(span.start, span.end)) !== "string") {
      throw new Error(`${filename} ${JSON.stringify(keys)}: expected a version string`);
    }
    return { ...span, value: JSON.stringify(value) };
  });
  for (const { start, end, value } of edits.sort((left, right) => right.start - left.start)) {
    text = text.slice(0, start) + value + text.slice(end);
  }
  return text;
}

function setVersionMetadata(root, version) {
  const fork = typeof version === "string" && version.includes("-ruivza.");
  const parsed = fork ? parseForkVersion(version) : parseOfficialVersion(version);
  const windowsVersion = fork
    ? `${parsed.major}.${parsed.minor}.${parsed.patch}.${parsed.revision}`
    : null;
  const plans = [
    { filename: "package.json", fields: [["version"]] },
    { filename: "package-lock.json", fields: [["version"], ["packages", "", "version"]] },
  ];
  // A stable version is temporary merge-base normalization. Do not read or
  // rewrite builder metadata during that step; retain the fork's Windows values.
  if (fork) {
    plans.push({
      filename: "electron-builder.json",
      fields: [
        ["extraMetadata", "shortVersion"],
        ["extraMetadata", "shortVersionWindows"],
      ],
    });
  }
  const prepared = plans.map(({ filename, fields }) => {
    const absolutePath = path.join(root, filename);
    const before = fs.readFileSync(absolutePath, "utf8");
    const after = replaceMetadata(
      before,
      fields.map((keys) => ({
        keys,
        value: filename === "electron-builder.json" ? windowsVersion : version,
      })),
      filename
    );
    return { filename, absolutePath, before, after };
  });
  const changedFiles = [];
  // Validate every input before writing any file. The caller owns the Git
  // transaction and discards its temporary checkout if an I/O operation fails.
  for (const { filename, absolutePath, before, after } of prepared) {
    if (before === after) continue;
    fs.writeFileSync(absolutePath, after, "utf8");
    changedFiles.push(filename);
  }
  return { version, windowsVersion, changedFiles };
}

function setMobileVersionMetadata(root, officialVersion, revision) {
  validateMobileVersion(officialVersion, revision);
  const filename = "openwhispr-mobile/config/fork-version.json";
  const absolutePath = path.join(root, filename);
  const before = fs.readFileSync(absolutePath, "utf8");
  const after = replaceMetadata(
    before,
    [
      { keys: ["upstreamVersion"], value: officialVersion },
      { keys: ["revision"], value: revision },
    ],
    filename
  );
  const changedFiles = [];
  if (before !== after) {
    fs.writeFileSync(absolutePath, after, "utf8");
    changedFiles.push(filename);
  }
  return {
    upstreamVersion: officialVersion,
    revision,
    forkVersion: `${officialVersion}.${revision}`,
    changedFiles,
  };
}

module.exports = {
  parseOfficialVersion,
  parseForkVersion,
  deriveNextVersion,
  setVersionMetadata,
  deriveMobileVersion,
  setMobileVersionMetadata,
};
