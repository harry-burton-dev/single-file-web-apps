import { defineApp } from "@trellis/framework";
import config from "./app.config";
import { Screen } from "./src/screen";

export const start = defineApp(config, Screen);
