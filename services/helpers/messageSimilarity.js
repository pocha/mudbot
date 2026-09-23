const chrono = require('chrono-node');

// Above this length, edit-distance's O(n*m) cost stops being worth it for a
// pre-send check that must stay fast — fall back to normalized exact-equality
// instead of computing a real ratio.
const MAX_COMPARE_LENGTH = 4000;

// Starting point, not a calibrated value — lower it to catch more near-misses
// (templated-variable resends), raise it to reduce false positives on
// legitimately similar but distinct messages. Exported so callers/tests can
// override.
const DEFAULT_THRESHOLD = 0.92;

// Replaces every date/time expression chrono-node recognizes with a fixed
// placeholder, back-to-front by match index so earlier replacements don't
// shift the offsets of matches still to be applied. Deliberately doesn't
// touch generic numbers (order IDs, OTP codes, amounts) — chrono-node only
// matches things it recognizes as date/time, so those are untouched by
// construction, and a changed number there usually means the messages are
// meant to be different, not a false near-duplicate.
function maskDynamicSegments(text) {
  const matches = chrono.parse(text);
  if (!matches.length) return text;
  let masked = text;
  for (const m of [...matches].sort((a, b) => b.index - a.index)) {
    masked = masked.slice(0, m.index) + '<datetime>' + masked.slice(m.index + m.text.length);
  }
  return masked;
}

function normalize(text) {
  return maskDynamicSegments(String(text)).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Classic full-matrix Levenshtein distance, single rolling row (O(min(n,m))
// space) — no dependency needed for this.
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prevRow = Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prevRow[j] = j;

  for (let i = 1; i <= a.length; i++) {
    const currRow = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1,      // deletion
        currRow[j - 1] + 1,  // insertion
        prevRow[j - 1] + cost // substitution
      );
    }
    prevRow = currRow;
  }
  return prevRow[b.length];
}

// 1.0 = identical (after normalization), 0.0 = maximally different.
function similarityRatio(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length > MAX_COMPARE_LENGTH || nb.length > MAX_COMPARE_LENGTH) {
    return 0; // treated as "not a duplicate" — exact match already returned above
  }
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  const distance = levenshteinDistance(na, nb);
  return 1 - distance / maxLen;
}

function isDuplicateMessage(a, b, threshold = DEFAULT_THRESHOLD) {
  if (a == null || b == null) return false;
  return similarityRatio(a, b) >= threshold;
}

module.exports = { isDuplicateMessage, similarityRatio, normalize, DEFAULT_THRESHOLD };
