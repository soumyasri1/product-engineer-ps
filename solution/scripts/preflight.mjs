// Fails fast with an actionable message instead of a confusing syntax error deep in a
// module. Two hard requirements: native TypeScript execution (Node >= 22.18, where type
// stripping is on by default) and the built-in `node:sqlite` module.
const MIN = [22, 18, 0];

const actual = process.versions.node.split(".").map(Number);
const tooOld = MIN.some((min, i) => {
  const part = actual[i] ?? 0;
  return part !== min ? part < min : false;
});

if (tooOld) {
  console.error(
    [
      "",
      `  This project requires Node >= ${MIN.join(".")} but found ${process.versions.node}.`,
      "",
      "  It has zero dependencies and runs TypeScript directly, which needs:",
      "    - native type stripping (Node 22.18+)",
      "    - the built-in node:sqlite module (Node 22.5+)",
      "",
      "  Install Node 22 LTS or 24 LTS from https://nodejs.org and re-run.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

try {
  await import("node:sqlite");
} catch {
  console.error(
    `\n  node:sqlite is unavailable in this Node build (${process.versions.node}).\n` +
      "  Use an official Node 22 LTS or 24 LTS distribution.\n",
  );
  process.exit(1);
}
