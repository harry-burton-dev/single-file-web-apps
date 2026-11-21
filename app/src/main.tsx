import { mount, TrellisApp } from "@trellis/framework";
import config from "../app.config";
import css from "./index.css?inline";
import { NoteScreen } from "./note-screen";

export const start = mount(
  <TrellisApp config={config}>
    <NoteScreen />
  </TrellisApp>,
  css,
);
