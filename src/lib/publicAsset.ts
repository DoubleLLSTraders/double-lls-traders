/** Public-folder URL that works on GitHub Pages (/repo/) and local dev (/). */
export function publicAsset(path: string): string {
  const file = path.replace(/^\//, "");
  return `${import.meta.env.BASE_URL}${file}`;
}
