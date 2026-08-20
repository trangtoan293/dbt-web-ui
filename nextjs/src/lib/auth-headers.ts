const BEARER_HEADER = /^Bearer [^\s]+$/;

export function isMalformedBearerHeader(value: string | null): boolean {
  return value !== null && !BEARER_HEADER.test(value);
}
