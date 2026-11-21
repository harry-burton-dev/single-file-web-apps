// The loader contract (ADR-0005 section 6): what the bootstrap hands to a
// bundle's start(). BOOTSTRAP_VERSION rises whenever this changes in a way an
// older bootstrap cannot serve; a bundle states the lowest one it needs
// (minBootstrap in the manifest) and the loader refuses it otherwise.
export const BOOTSTRAP_VERSION = 1;

export type UpdateResult =
  | { status: "current"; version: string }
  | { status: "updated"; version: string }
  | { status: "rejected"; code: string; message: string };

export interface LoaderServices {
  contract: 1;
  bootstrapVersion: number;
  /** The version of the bundle being run. */
  version: string;
  /** The page was opened with #safe: run without plugins. */
  safe: boolean;
  /** The element the app renders into. */
  mount: HTMLElement;
  /**
   * Call once the shared folder is connected. Checks the folder for a new
   * signed version now and every 15 minutes after; the bootstrap tells the
   * user when one is ready or was refused, unless the app has subscribed
   * through onUpdate.
   */
  checkForUpdate(root: FileSystemDirectoryHandle): Promise<UpdateResult>;
  /**
   * Hear each update check's result. While anything is subscribed the
   * bootstrap draws no note of its own. A subscriber that arrives after a
   * check hears its result at once. Returns the unsubscribe function.
   * Optional: added within contract 1, before any bootstrap was handed out.
   */
  onUpdate?(listener: (result: UpdateResult) => void): () => void;
}
