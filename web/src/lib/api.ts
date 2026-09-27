/**
 * Calling diffd's JSON API through the client generated from its OpenAPI
 * description (`src/api`, made by `just types`), so requests and responses
 * are typed end to end.
 */

/** What a generated SDK call resolves to. */
interface Result<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response?: Response;
}

/** The data of a successful call; otherwise an error with the server's message. */
export async function ok<T>(call: Promise<Result<T>>, what: string): Promise<Exclude<T, undefined>> {
  const { data, error, response } = await call;
  if (response?.ok && data !== undefined) return data as Exclude<T, undefined>;
  const message = typeof error === "string" && error.trim() ? error : null;
  throw new Error(message ?? `Couldn't ${what} (${response?.status ?? "no connection"})`);
}
