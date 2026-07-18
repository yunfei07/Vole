export function joinUrl(baseUrl: string, target: string): string {
  return new URL(target, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}
