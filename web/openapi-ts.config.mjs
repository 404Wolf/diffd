// The page's API client and types, generated from the server's OpenAPI
// description by `just types`. (A plain object: the generator runs in its own
// npx environment, since it needs TypeScript's JS API, which TypeScript 7 doesn't have.)
export default {
  input: "./openapi.json",
  output: { path: "./src/api" },
  plugins: ["@hey-api/client-fetch", "@hey-api/typescript", "@hey-api/sdk"],
};
