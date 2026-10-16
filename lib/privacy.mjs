// Best-effort display redaction, not a security boundary.
export function clip(value, limit = 180) {
  return String(value ?? '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(-u\s+)\S+:\S+/g, '$1[redacted]')
    .replace(/((?:--)?(?:password|token|secret|authorization|api[_-]?key)["']?\s*(?:[:=]\s*|\s+))["']?[^\s,;"'}]+["']?/gi, '$1[redacted]')
    .replace(/\b(?:sk-[\w-]+|ghp_[\w]+|github_pat_[\w_]+|xox[bp]-[\w-]+|AKIA[A-Z0-9]+)\b/g, '[redacted]')
    .slice(0, limit);
}
