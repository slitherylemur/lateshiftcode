/** A stable, theme-aware title color derived solely from project identity. */
export function projectTitleColor(projectIdentity: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < projectIdentity.length; index += 1) {
    hash ^= projectIdentity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const hue = (hash >>> 0) % 360;
  return `light-dark(hsl(${hue} 72% 36%), hsl(${hue} 78% 72%))`;
}
