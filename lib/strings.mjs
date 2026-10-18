export function truncate(value, limit) {
  if (value.length <= limit) return value;
  const high = value.charCodeAt(limit - 1), low = value.charCodeAt(limit);
  return value.slice(0, high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? limit - 1 : limit);
}
