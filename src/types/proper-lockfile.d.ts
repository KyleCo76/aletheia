declare module 'proper-lockfile' {
  interface LockOptions {
    stale?: number;
    update?: number;
    retries?: number | { retries?: number; minTimeout?: number; maxTimeout?: number; factor?: number; randomize?: boolean };
    realpath?: boolean;
    fs?: object;
    onCompromised?: (err: Error) => void;
    lockfilePath?: string;
  }

  interface UnlockOptions {
    realpath?: boolean;
    fs?: object;
    lockfilePath?: string;
  }

  interface CheckOptions {
    stale?: number;
    realpath?: boolean;
    fs?: object;
    lockfilePath?: string;
  }

  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  export function unlock(file: string, options?: UnlockOptions): Promise<void>;
  export function check(file: string, options?: CheckOptions): Promise<boolean>;
  export function lockSync(file: string, options?: LockOptions): () => void;
  export function unlockSync(file: string, options?: UnlockOptions): void;
  export function checkSync(file: string, options?: CheckOptions): boolean;
}
