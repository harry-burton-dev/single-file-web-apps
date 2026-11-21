// Every name the framework gives an app, derived from its id and name.
import type { AppDefinition } from "./definition";

export function appNames({ id, name }: Pick<AppDefinition, "id" | "name">) {
  return {
    database: id,
    deviceLock: (deviceId: string) => `${id}-device-${deviceId}`,
    folderPicker: id,
    title: name,
    bootstrapFile: `${id}.html`,
    bundleFile: (version: string) => `${id}-${version}.js`,
    releaseFolder: name,
    releaseZip: (version: string) => `${id}-${version}.zip`,
  };
}
