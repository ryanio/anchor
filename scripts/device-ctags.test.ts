import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  nativeArduinoCtagsBuildProperty,
  nativeArduinoCtagsPaths,
  needsNativeArduinoCtags,
} from "./device-ctags.ts";

describe("native Arduino ctags", () => {
  test("is needed only for Apple Silicon", () => {
    assert.equal(needsNativeArduinoCtags("darwin", "arm64"), true);
    assert.equal(needsNativeArduinoCtags("darwin", "x64"), false);
    assert.equal(needsNativeArduinoCtags("linux", "arm64"), false);
  });

  test("overrides the runtime property with the directory containing ctags", () => {
    const root = "/work/anchor";
    const paths = nativeArduinoCtagsPaths(root);
    assert.equal(paths.binary, join(root, ".cache", "device", "tools", "ctags-native", "bin", "ctags"));
    assert.deepEqual(nativeArduinoCtagsBuildProperty(root, "darwin", "arm64"), [
      "--build-property",
      `runtime.tools.ctags.path=${join(root, ".cache", "device", "tools", "ctags-native", "bin")}`,
    ]);
    assert.deepEqual(nativeArduinoCtagsBuildProperty(root, "linux", "arm64"), []);
  });
});
