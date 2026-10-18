// Only invalidations are needed from SSE, never tool outputs. Oversized frames
// trigger snapshot reconciliation instead of creating multi-megabyte strings.
export class EventFrames {
  constructor(limit = 65536) { this.limit = limit; this.buffer = ''; this.discarding = false; this.uncertain = false; this.ids = new Set(); }
  push(text) {
    this.buffer = (this.buffer + text).replace(/\r\n/g, '\n');
    const frames = [], sessionIds = new Set(); let end, overflow = false, unknownOverflow = false;
    const identify = text => { for (const match of text.matchAll(/"sessionID"\s*:\s*"(ses_[\w-]+)"/g)) { if (this.ids.size < 16) this.ids.add(match[1]); if (this.ids.size >= 16) this.uncertain = true; } };
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const frame = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 2);
      if (this.discarding || frame.length > this.limit) {
        identify(frame); overflow = true; this.discarding = false;
        if (this.uncertain || !this.ids.size) unknownOverflow = true;
        for (const id of this.ids) sessionIds.add(id); this.ids.clear(); this.uncertain = false;
      }
      else frames.push(frame);
    }
    if (this.buffer.length > this.limit) { identify(this.buffer); this.discarding = true; this.uncertain = true; this.buffer = this.buffer.slice(-2); }
    return { frames, overflow, ...(sessionIds.size ? { sessionIds: [...sessionIds] } : {}), ...(unknownOverflow ? { unknownOverflow: true } : {}) };
  }
}
