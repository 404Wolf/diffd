// After `openapi-ts`: the fetch runtime it copies in (src/api/client, src/api/core)
// is library code written for looser compiler settings than ours
// (exactOptionalPropertyTypes), so it isn't type-checked. The API's types and
// functions (types.gen.ts, sdk.gen.ts) are, like everything else.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

for (const dir of ["src/api/client", "src/api/core"]) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const text = readFileSync(path, "utf8");
    if (name.endsWith(".ts") && !text.startsWith("// @ts-nocheck")) writeFileSync(path, `// @ts-nocheck\n${text}`);
  }
}
