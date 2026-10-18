// Only invalidations are needed from SSE, never tool outputs. Oversized frames
// trigger snapshot reconciliation instead of creating multi-megabyte strings.
export class EventFrames {
  constructor(limit = 65536) { this.limit = limit; this.buffer = ''; this.discarding = false; }
  push(text) {
    this.buffer = (this.buffer + text).replace(/\r\n/g, '\n');
    const frames = []; let end, overflow = false;
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const frame = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 2);
      if (this.discarding || frame.length > this.limit) { overflow = true; this.discarding = false; }
      else frames.push(frame);
    }
    if (this.buffer.length > this.limit) { this.discarding = true; this.buffer = this.buffer.slice(-2); }
    return { frames, overflow };
  }
}
