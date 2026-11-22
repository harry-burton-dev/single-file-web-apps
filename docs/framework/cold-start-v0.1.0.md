# Cold start, v0.1.0 (gate G12)

Run on 2026-11-22 for OUT-31. Gate G12: a fresh agent given only `docs/quickstart.md` and a created project adds a second table and a screen that syncs, without editing framework folders.

**Result: passed on run 3 of 3.** All three runs passed the checks. Runs 1 and 2 left questions the quickstart should have answered, so the docs (and, after run 1, the framework) were fixed and a new agent ran again each time. Run 3 is the passing run.

## Setup, the same for every run

- `npm run create -- demo-app --dir /tmp/coldstart-<n>` from this repository at the commit under test, then one commit in `demo-app` ("Create demo-app") as the baseline, as section 1 of the quickstart says.
- A new general-purpose agent session with no context from the building thread. Its whole prompt named the project folder and `docs/quickstart.md` as its only inputs, set the task below, told it to stay inside `/tmp/coldstart-<n>/`, and gave two facts about the machine, not the framework: Playwright and Chromium are installed globally and browser downloads are blocked, so skip the Playwright install step; git needs a user name to commit. It was told not to commit.
- The task, word for word: "add a second table to the app, and a screen that shows and edits that table's records so they sync between users. Choose the table and its fields yourself. Then make sure the project's own checks pass." It was also told to run `npm run ci` and `npm run two-users` before finishing, and to report every command, every file it opened, and every question the quickstart left it with.
- Its tool calls were read back from the session transcript, not only from its report.

## Checks run on each result, by the building thread

```sh
git add -N . && git diff --stat                       # what changed
git diff -- framework masters .github package.json package-lock.json | wc -l   # must be 0
export TRELLIS_PUBLIC_KEY="$(npm run --silent keygen | sed -n 's/^TRELLIS_PUBLIC_KEY=//p')"
npm run ci                                            # includes the per-table sync test (from run 2 on)
npm run two-users                                     # two browsers, one folder, from built files
```

For run 1, which predates the per-table test, the same check was a script outside the project that creates a record with a value in every field of each new table on one engine and reads it on a second engine through one memory folder. It was seen to fail with the sync step removed.

## Runs

| Run | Framework commit | Table it added | Checks | Framework files opened | Changed afterwards |
|---|---|---|---|---|---|
| 1 | `462ba2b` | `contacts` (6 fields, every kind) | ci, two-users and the outside sync script pass; 0 lines of framework diff | none | Docs, and a per-table sync test in the framework |
| 2 | `3d12e07` | `contacts` (5 fields, every kind) | ci (with `table contacts` sync test), two-users pass; 0 lines of framework diff | none | Docs |
| 3 | `e3a7c77` | `contacts` (5 fields, every kind) | ci (with `table contacts` sync test), two-users pass; 0 lines of framework diff | none | Nothing |

Before run 1, every command in the quickstart was run as written against a created project (`my-app`, with the `people` table and screen from section 3). That dry run found two failures in a created project's own `npm run ci`, both fixed before any agent saw the project:

1. `framework/runtime/test/empty-app.test.js` (gate G4) fails a project whose field is called `name`, because framework source quotes `"name"`. Before the first commit it passed only because `git ls-files` listed nothing.
2. `framework/test/app-size.test.js` holds the app to 150 lines, so a project's own app would fail its checks as it grows (the dry run reached 118).

Both checks are about the framework's own example app. `create` now leaves them out of a created project.

### Run 1 (transcript summary)

Read the quickstart, then `app/app.config.ts`, `app/src/main.tsx`, `app/src/items-screen.tsx`, `package.json` and `README.md`. Added `contacts` and `ContactsScreen` in one edit, then ran `npm run typecheck`, `npm run ci` and `npm run two-users`. All passed first time. 7 tool calls.

Questions it raised, and what changed:

- It was handed an existing project: does it still run `create` and commit? The quickstart now says to skip to the key step and treat the last commit as the start.
- Is the key needed again in each shell, and for `two-users` too? Now: set it once in each new terminal, before `ci`, `build` or `two-users`.
- How is a `text` field written? Now: pass the whole new text; the framework merges.
- How does it check its own table syncs? The two-user test drives only `items`, and it lives under `framework/`. **Fixed in the framework**: `framework/data/test/app-tables-sync.test.js` runs one test per table in `app/app.config.ts` in `npm test`, and the quickstart says so.
- What is an `ask` field before anyone sets it, and is the first set a conflict? Now: `undefined`, and no.
- Are number fields validated? Now: a wrong type or an undeclared field is refused with code `invalid`; ranges are the screen's.
- Does a new table need `migrations`? Now: no.
- Should screens carry headings? Not answered: a design choice for the app.

### Run 2 (transcript summary)

Read the quickstart, listed the tracked files, read the same four app files and `README.md`, wrote the table and screen, ran `npm run ci` (its log shows `table contacts` in the sync test) and `npm run two-users`. All passed first time. 7 tool calls.

Questions, and what changed:

- Is the existing commit the baseline? Now said in section 1.
- What does a bare `"latest"` or `"ask"` accept? Now: any value but `undefined`, typed `unknown`; prefer a typed field.
- Does `keygen` write files? Now: it prints two lines and writes no file.
- Nothing tests the new screen in a browser. Now said plainly: own screens are checked by typecheck and build; try them with `npm run dev`. This stays a known limit of v0.1.0.
- Headings and the pattern for number inputs: not answered, screen design.

### Run 3 (transcript summary, the passing run)

Read the quickstart, listed the tracked files (names only under `framework/` and `.github/`; none opened), read `app/app.config.ts`, `app/src/main.tsx`, `app/src/items-screen.tsx` and `package.json`, wrote the table and screen, ran `npm run ci` and `npm run two-users`. Both passed first time. 8 tool calls, none outside `/tmp/coldstart-3/`.

Questions it raised, left open:

- A typed number field cannot be set back to empty, since a command refuses `undefined`. The screen ignores blank input. A real limit of the record layer in v0.1.0, listed for the release notes.
- The quickstart's screen example passes an inline object to `update`; the example app types its edits with `RowOf`. Both typecheck; the agent followed the example app.
- How `sort` treats a record with no value: not stated (missing values sort last).
- Whether the key must match between runs: the quickstart already says any key will do for a local check.
- Headings and layout between two screens: screen design.

None of these needed a framework file or changes the task's outcome, so no fourth run was made.

Check output for run 3:

```
$ git diff --stat
 app/app.config.ts           | 11 ++++++++
 app/src/contacts-screen.tsx | 63 +++++++++++++++++++++++++++++++++++++++++++++
 app/src/main.tsx            |  2 ++
 3 files changed, 76 insertions(+)
$ git diff -- framework masters .github package.json package-lock.json | wc -l
0
$ npm run ci
exit 0 (... ok 1 - table items: ... ok 2 - table contacts: a record one user creates reaches the other with every field ...)
$ npm run two-users
exit 0 (two-user test passed)
```

## Run 3 diff

```diff
diff --git a/app/app.config.ts b/app/app.config.ts
index a932552..f728d62 100644
--- a/app/app.config.ts
+++ b/app/app.config.ts
@@ -14,6 +14,17 @@ const config = {
         owner: { kind: "ask", type: "string" },
       },
     },
+    // Contacts the team shares: name and email last-write-wins, notes merged, budget asked on conflict.
+    contacts: {
+      version: 1,
+      fields: {
+        name: { kind: "latest", type: "string" },
+        email: { kind: "latest", type: "string" },
+        favourite: { kind: "latest", type: "boolean" },
+        notes: "text",
+        budget: { kind: "ask", type: "number" },
+      },
+    },
   },
 } satisfies AppDefinition;
 
diff --git a/app/src/contacts-screen.tsx b/app/src/contacts-screen.tsx
new file mode 100644
index 0000000..0fe292e
--- /dev/null
+++ b/app/src/contacts-screen.tsx
@@ -0,0 +1,63 @@
+// The contacts screen: list contacts by name, add one, edit in place, remove.
+// Reads with the data hooks, writes with the built-in commands. Conflicts on
+// the budget (an "ask" field) are shown by the shell, not here.
+import { useState, type FormEvent } from "react";
+import { Button, useCommand, useRecords, type RowOf } from "@trellis/framework";
+
+const field = "rounded-md border bg-background p-2 text-sm";
+
+type Editable = Partial<Pick<RowOf<"contacts">, "name" | "email" | "favourite" | "notes" | "budget">>;
+
+export function ContactsScreen() {
+  const contacts = useRecords("contacts", { sort: "name" });
+  const create = useCommand("records.create");
+  const [name, setName] = useState("");
+
+  const add = (e: FormEvent) => {
+    e.preventDefault();
+    if (!name.trim()) return;
+    create({ table: "contacts", fields: { name: name.trim(), favourite: false } });
+    setName("");
+  };
+
+  return (
+    <section id="contacts" aria-label="Contacts" className="flex flex-col gap-3">
+      <h2 className="text-lg font-semibold">Contacts</h2>
+      <form id="add-contact" onSubmit={add} className="flex gap-2">
+        <input id="new-contact-name" aria-label="New contact" placeholder="New contact" className={`flex-1 ${field}`} value={name} onChange={(e) => setName(e.target.value)} />
+        <Button id="add-contact-button" type="submit">Add</Button>
+      </form>
+      {contacts.length === 0 && <p className="text-sm text-muted-foreground">No contacts yet.</p>}
+      <ul id="contact-list" aria-label="Contact list" className="flex flex-col gap-2">
+        {contacts.map((contact) => <ContactRow key={contact.id} contact={contact} />)}
+      </ul>
+    </section>
+  );
+}
+
+function ContactRow({ contact }: { contact: RowOf<"contacts"> }) {
+  const update = useCommand("records.update");
+  const remove = useCommand("records.remove");
+  const set = (fields: Editable) => update({ table: "contacts", id: contact.id, fields });
+  const id = `contact-${contact.id}`;
+  const label = contact.name || "Unnamed";
+
+  const setBudget = (raw: string) => {
+    const n = Number(raw);
+    // Blank or non-numeric input is ignored; the field only takes numbers.
+    if (raw.trim() !== "" && Number.isFinite(n)) set({ budget: n });
+  };
+
+  return (
+    <li id={id} data-id={contact.id} aria-label={label} className="flex flex-col gap-2 rounded-lg border p-3">
+      <div className="flex flex-wrap items-center gap-2">
+        <input id={`${id}-favourite`} type="checkbox" aria-label={`Favourite: ${label}`} checked={contact.favourite ?? false} onChange={(e) => set({ favourite: e.target.checked })} />
+        <input id={`${id}-name`} aria-label="Name" className={`flex-1 ${field}`} value={contact.name ?? ""} onChange={(e) => set({ name: e.target.value })} />
+        <input id={`${id}-email`} type="email" aria-label="Email" placeholder="Email" className={`w-48 ${field}`} value={contact.email ?? ""} onChange={(e) => set({ email: e.target.value })} />
+        <input id={`${id}-budget`} type="number" aria-label="Budget" placeholder="Budget" className={`w-28 ${field}`} value={contact.budget ?? ""} onChange={(e) => setBudget(e.target.value)} />
+        <Button id={`${id}-remove`} variant="outline" onClick={() => remove({ table: "contacts", id: contact.id })}>Remove</Button>
+      </div>
+      <textarea id={`${id}-notes`} aria-label="Notes" placeholder="Notes" className={`min-h-16 ${field}`} value={contact.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} />
+    </li>
+  );
+}
diff --git a/app/src/main.tsx b/app/src/main.tsx
index 4949b03..69dfaec 100644
--- a/app/src/main.tsx
+++ b/app/src/main.tsx
@@ -1,11 +1,13 @@
 import { mount, TrellisApp } from "@trellis/framework";
 import config from "../app.config";
 import css from "./index.css?inline";
+import { ContactsScreen } from "./contacts-screen";
 import { ItemsScreen } from "./items-screen";
 
 export const start = mount(
   <TrellisApp config={config}>
     <ItemsScreen />
+    <ContactsScreen />
   </TrellisApp>,
   css,
 );
```
