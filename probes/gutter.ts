// Draft for web/src/components/Buffer.tsx: selecting lines by their numbers.

  // -- Line numbers select lines: press, drag, release opens the composer ----------
  // One pointer path for a mouse, a finger or a pen. Line numbers are `touch-action:
  // none` (styles.css), so a drag that starts on them selects rather than scrolls.
  /** The drag in progress: its pointer, file, side, and whether it has left its first row. */
  let drag: { id: number; file: number; side: Side; first: number; moved: boolean; extend: boolean } | null =
    null;
  let edgeScroll = 0;
  let lastY = 0;
  const rowUnder = (x: number, y: number, file: number): HTMLElement | null => {
    const buf = bufferEl(props.pane.id);
    if (!buf) return null;
    const box = buf.getBoundingClientRect();
    // Past the top or bottom of the buffer: the row at that edge.
    const at = document.elementFromPoint(
      Math.min(Math.max(x, box.left + 1), box.right - 1),
      Math.min(Math.max(y, box.top + 1), box.bottom - 1),
    );
    const row = at?.closest<HTMLElement>(".row[data-f]");
    return row && Number(row.dataset.f) === file ? row : null;
  };
  const dragTo = (x: number, y: number) => {
    if (!drag) return;
    const row = rowUnder(x, y, drag.file);
    if (!row || !hasSide(row, drag.side)) return;
    if (Number(row.dataset.r) !== drag.first) drag.moved = true;
    props.cmd.place(row, { side: drag.side, scroll: false });
  };
  /** Near the buffer's top or bottom edge while dragging: keep scrolling that way. */
  const EDGE_PX = 36;
  const scrollAtEdge = () => {
    cancelAnimationFrame(edgeScroll);
    const buf = bufferEl(props.pane.id);
    if (!drag || !buf) return;
    const box = buf.getBoundingClientRect();
    const by = lastY < box.top + EDGE_PX ? lastY - (box.top + EDGE_PX) : lastY > box.bottom - EDGE_PX ? lastY - (box.bottom - EDGE_PX) : 0;
    if (by === 0) return;
    buf.scrollTop += Math.round(by / 3);
    dragTo(box.left + box.width / 2, lastY);
    edgeScroll = requestAnimationFrame(scrollAtEdge);
  };
