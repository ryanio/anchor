/**
 * Read a secret from the terminal without echoing it.
 *
 * Not via readline: suppressing echo by stubbing `readline`'s private `_writeToOutput` breaks
 * `question()` in current Node — the promise never settles and the process exits with
 * "Detected unsettled top-level await". Raw mode is the supported way to do this.
 *
 * Falls back to a plain line read when stdin is not a TTY, so `echo key | script --set-key` works
 * in CI and in tests.
 */
export function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(prompt);

  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk) => {
        data += chunk;
      });
      stdin.on("end", () => resolve(data.split("\n")[0]!.trim()));
      stdin.on("error", reject);
    });
  }

  return new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw === true;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let buffer = "";
    const done = (fn: () => void) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stderr.write("\n");
      fn();
    };

    // Raw mode delivers chunks, not single characters — a paste arrives all at once.
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(() => resolve(buffer.trim()));
        if (ch === "\u0003") return done(() => reject(new Error("cancelled")));
        if (ch === "\u007f" || ch === "\b") {
          buffer = buffer.slice(0, -1);
        } else if (ch >= " ") {
          buffer += ch;
        }
      }
    };

    stdin.on("data", onData);
  });
}
