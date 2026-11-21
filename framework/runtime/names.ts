// Every name the framework gives an app, derived from its id and name.
import type { AppDefinition } from "./definition";

export function appNames({ id, name }: Pick<AppDefinition, "id" | "name">) {
  return {
    database: id,
    /** The admin page's own database, so it and the app can be open together. */
    adminDatabase: `${id}-admin`,
    deviceLock: (deviceId: string) => `${id}-device-${deviceId}`,
    folderPicker: id,
    title: name,
    bootstrapFile: `${id}.html`,
    adminFile: `${id}-admin.html`,
    bundleFile: (version: string) => `${id}-${version}.js`,
    releaseFolder: name,
    releaseZip: (version: string) => `${id}-${version}.zip`,
  };
}
