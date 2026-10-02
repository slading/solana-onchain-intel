/** Human byte size for a UTF-8 string, used only for CLI footers. */
export function byteSize(text: string): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
