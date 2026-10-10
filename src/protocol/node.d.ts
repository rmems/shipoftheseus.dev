/** Minimal Node declarations for build-time protocol fixture ingest. Not a browser API. */
declare module 'node:fs' {
  export function readFileSync(path: string): Uint8Array;
}

declare module 'node:crypto' {
  export function createHash(algorithm: 'sha256'): {
    update(data: Uint8Array): { digest(encoding: 'hex'): string };
  };
}
