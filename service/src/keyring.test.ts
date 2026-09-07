import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { looksLikeCredential } from "./keyring.ts";
describe("looksLikeCredential", () => {
  it("accepts opaque tokens", () => {
    assert.ok(looksLikeCredential("0123456789abcdef0123456789abcdef"));
    assert.ok(looksLikeCredential("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig-_~+/="));
  });

  // The regression this was written for: a non-TTY stdin fed the reader its own command line, and
  // the command line was stored as the credential. Both real values are reproduced exactly.
  it("rejects a shell command that arrived instead of a secret", () => {
    assert.equal(looksLikeCredential("node ~/Projects/anchor/service/src/index.ts --set-pat"), false);
    assert.equal(
      looksLikeCredential("node /home/rg/Projects/anchor/service/src/index.ts --set-api-key"),
      false,
    );
  });

  it("rejects anything carrying whitespace or control characters", () => {
    for (const bad of ["two words", "tab\there", "new\nline", "trailing ", " leading", ""]) {
      assert.equal(looksLikeCredential(bad), false, JSON.stringify(bad));
    }
  });
});
