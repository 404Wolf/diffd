/** How a file's status shows: a letter and its color, in the tree and on file headers. */
import type { FileStatus } from "../gen/FileStatus";

export const STATUS: Record<FileStatus, { readonly letter: string; readonly color: string }> = {
  added: { letter: "A", color: "text-add" },
  deleted: { letter: "D", color: "text-del" },
  modified: { letter: "M", color: "text-warn" },
  renamed: { letter: "R", color: "text-accent" },
  unchanged: { letter: "·", color: "text-subtle" },
};
