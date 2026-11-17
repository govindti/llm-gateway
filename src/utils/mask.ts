/** Never log or echo a full API key. */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 4) return "***";
  return `***${apiKey.slice(-4)}`;
}
