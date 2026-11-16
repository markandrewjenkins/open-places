// Runs the shared headline name-redaction (site/src/shared/redact-names.js) for the Python snapshot pipeline.
// stdin: a JSON array of headlines; stdout: the same array with names taken out. Used by pipelines/local/build.py.
import { redactHeadline } from "../../site/src/shared/redact-names.js";

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { buf += c; });
process.stdin.on("end", () => {
  const titles = JSON.parse(buf || "[]");
  process.stdout.write(JSON.stringify(titles.map((t) => redactHeadline(t))));
});
