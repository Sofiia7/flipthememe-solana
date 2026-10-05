// Expo config plugin: release signing for android/app/build.gradle after prebuild.
//
// Adds a `release` signingConfig that reads the keystore from environment variables
// and points buildTypes.release at it:
//   FTM_KEYSTORE_FILE      absolute path to the PKCS12 keystore (release.p12)
//   FTM_KEYSTORE_PASSWORD  store password (the key password is the same)
//   FTM_KEY_ALIAS          key alias
// When FTM_KEYSTORE_FILE is not set, release builds keep using the debug keystore,
// so local `expo run:android --variant release` still works without secrets.
//
// Idempotent: running prebuild again (with or without --clean) yields the same file.
const { withAppBuildGradle } = require("expo/config-plugins");

const TAG = "ftm-release-signing";
const BEGIN = `// @generated begin ${TAG}`;
const END = `// @generated end ${TAG}`;
const RELEASE_LINE = `signingConfig System.getenv("FTM_KEYSTORE_FILE") ? signingConfigs.release : signingConfigs.debug // ${TAG}`;

const signingBlock = (indent) =>
  [
    `${indent}${BEGIN}`,
    `${indent}release {`,
    `${indent}    def ftmKeystoreFile = System.getenv("FTM_KEYSTORE_FILE")`,
    `${indent}    if (ftmKeystoreFile) {`,
    `${indent}        storeFile file(ftmKeystoreFile)`,
    `${indent}        storeType "pkcs12"`,
    `${indent}        storePassword System.getenv("FTM_KEYSTORE_PASSWORD")`,
    `${indent}        keyAlias System.getenv("FTM_KEY_ALIAS")`,
    `${indent}        keyPassword System.getenv("FTM_KEYSTORE_PASSWORD")`,
    `${indent}    }`,
    `${indent}}`,
    `${indent}${END}`,
  ].join("\n");

// Index of the `}` that closes the `{` at openIdx. Skips comments and string literals.
function findClosingBrace(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
    } else if (c === "/" && next === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close === -1 ? src.length : close + 1;
    } else if (c === '"' || c === "'") {
      for (i++; i < src.length && src[i] !== c; i++) {
        if (src[i] === "\\") i++;
      }
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Returns { open, close } for the first `name {` block at or after `from` (and before `limit`).
function findBlock(src, name, from = 0, limit = src.length) {
  const re = new RegExp(`(^|[^\\w.])${name}\\s*\\{`, "g");
  re.lastIndex = from;
  const m = re.exec(src);
  if (!m || m.index >= limit) return null;
  const open = m.index + m[0].length - 1;
  const close = findClosingBrace(src, open);
  if (close === -1 || close > limit) return null;
  return { open, close };
}

function lineIndentAt(src, idx) {
  const lineStart = src.lastIndexOf("\n", idx) + 1;
  return /^[ \t]*/.exec(src.slice(lineStart))[0];
}

function applyReleaseSigning(src) {
  // 1. Drop a previously generated block so the current version is written exactly once.
  const genStart = src.indexOf(BEGIN);
  if (genStart !== -1) {
    const genEnd = src.indexOf(END, genStart);
    if (genEnd === -1) throw new Error(`[${TAG}] found "${BEGIN}" without "${END}" in app/build.gradle`);
    const from = src.lastIndexOf("\n", genStart); // start of the line holding BEGIN
    const to = src.indexOf("\n", genEnd); // end of the line holding END
    src = src.slice(0, from) + (to === -1 ? "" : src.slice(to));
  }

  // 2. signingConfigs { ... } inside android { ... }: add the env-driven `release` config.
  const android = findBlock(src, "android");
  if (!android) throw new Error(`[${TAG}] no "android {" block in app/build.gradle`);
  const signing = findBlock(src, "signingConfigs", android.open, android.close);
  if (!signing) throw new Error(`[${TAG}] no "signingConfigs {" block in app/build.gradle`);
  const blockIndent = lineIndentAt(src, signing.open) + "    ";
  const insertAt = src.indexOf("\n", signing.open) + 1;
  src = src.slice(0, insertAt) + signingBlock(blockIndent) + "\n" + src.slice(insertAt);

  // 3. buildTypes { release { signingConfig ... } }: use the release config when the keystore is set.
  const androidAfter = findBlock(src, "android");
  const buildTypes = findBlock(src, "buildTypes", androidAfter.open, androidAfter.close);
  if (!buildTypes) throw new Error(`[${TAG}] no "buildTypes {" block in app/build.gradle`);
  const release = findBlock(src, "release", buildTypes.open + 1, buildTypes.close);
  if (!release) throw new Error(`[${TAG}] no "release {" build type in app/build.gradle`);
  const body = src.slice(release.open + 1, release.close);
  const lineRe = /^([ \t]*)signingConfig\b.*$/m;
  const m = lineRe.exec(body);
  let newBody;
  if (m) {
    newBody = body.replace(lineRe, `${m[1]}${RELEASE_LINE}`);
  } else {
    const indent = lineIndentAt(src, release.open) + "    ";
    newBody = `\n${indent}${RELEASE_LINE}` + body;
  }
  return src.slice(0, release.open + 1) + newBody + src.slice(release.close);
}

const withReleaseSigning = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error(`[${TAG}] only a Groovy app/build.gradle is supported, got "${cfg.modResults.language}"`);
    }
    cfg.modResults.contents = applyReleaseSigning(cfg.modResults.contents);
    return cfg;
  });

module.exports = withReleaseSigning;
module.exports.applyReleaseSigning = applyReleaseSigning;
