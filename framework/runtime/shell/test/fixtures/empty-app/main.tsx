// An app with no tables and no screens, built by empty-app-build.test.ts.
import { mount, TrellisApp } from "@trellis/framework";

export const start = mount(<TrellisApp config={{ id: "empty", name: "Empty", tables: {} }} />, "");
