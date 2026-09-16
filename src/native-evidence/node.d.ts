/** Minimal Node declarations for build-time catalog ingest. Not a browser API. */
declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function statSync(path: string): { size: number; isDirectory(): boolean };
}

declare module 'node:path' {
  export function extname(path: string): string;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare const process: { cwd(): string };
