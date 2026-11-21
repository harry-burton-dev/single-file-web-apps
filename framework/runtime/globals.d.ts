/// <reference types="vite/client" />
declare const __APP_VERSION__: string;
declare const __BUILT_AT__: string;
/** The admin's public signing key (ECDSA P-256, JWK), built into the bootstrap. */
declare const __SIGNING_PUBLIC_KEY__: JsonWebKey;

// File System Access API members not yet in TypeScript's DOM library.
interface FileSystemPermissionDescriptor {
  mode?: "read" | "readwrite";
}
interface FileSystemHandle {
  queryPermission(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
}
interface Window {
  showDirectoryPicker(options?: { id?: string; mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>;
}
