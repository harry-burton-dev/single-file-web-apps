import { mount, TrellisApp } from "@trellis/framework";
import config from "../app.config";
import css from "./index.css?inline";
import { ItemsScreen } from "./items-screen";

export const start = mount(
  <TrellisApp config={config}>
    <ItemsScreen />
  </TrellisApp>,
  css,
);
