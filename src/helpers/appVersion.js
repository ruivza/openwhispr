const CANONICAL_APP_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseCanonicalAppVersion(value) {
  if (typeof value !== "string") return null;
  const match = CANONICAL_APP_VERSION.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function isCanonicalAppVersion(value) {
  return parseCanonicalAppVersion(value) !== null;
}

// Fork release suffixes identify builds of the same upstream app version.
// Normalize only installed versions; server policy minimums remain canonical.
function normalizeInstalledAppVersion(value) {
  if (isCanonicalAppVersion(value)) return value;
  if (typeof value !== "string") return null;
  const match = /^(.*)-ruivza\.([1-9]\d*)$/.exec(value);
  return match && isCanonicalAppVersion(match[1]) && Number.isSafeInteger(Number(match[2]))
    ? match[1]
    : null;
}

function compareAppVersions(a, b) {
  const left = parseCanonicalAppVersion(a);
  const right = parseCanonicalAppVersion(b);
  if (!left) return right ? -1 : 0;
  if (!right) return 1;
  for (let index = 0; index < 3; index++) {
    const difference = left[index] - right[index];
    if (difference) return difference;
  }
  return 0;
}

module.exports = {
  isCanonicalAppVersion,
  parseCanonicalAppVersion,
  normalizeInstalledAppVersion,
  compareAppVersions,
};
