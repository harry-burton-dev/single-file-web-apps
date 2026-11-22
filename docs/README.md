# Documentation

The framework is a starting point for small team apps that run from a shared folder, with no server. You describe your tables and write your screens. Sync, encryption, sign-in, signed updates and the app shell are already done.

New here? Start with the [quick start](quickstart.md).

## Quick start

[Quickstart](quickstart.md): create a project, declare a table, write a screen, invite a user, release.

## Guides

How to do one job.

**Building the app**

- [Declare a table and field rules](guides/declare-a-table.md)
- [Read with hooks](guides/read-with-hooks.md)
- [Write a command](guides/write-a-command.md)
- [Handle a conflict](guides/handle-a-conflict.md)
- [Add a migration](guides/add-a-migration.md)

**Running a workspace**

- [Invite a user](guides/invite-a-user.md)
- [Back up and restore](guides/back-up-and-restore.md)
- [Cut a signed release](guides/release.md)
- [Roll back a release](guides/roll-back.md)

## Reference

Facts to look up.

- [API reference](reference/api.md): everything `@trellis/framework` exports
- [`app.config.ts`](reference/app-config.md): the definition file and its rules
- [npm scripts](reference/scripts.md)
- [Messages](reference/messages.md): every message the app shows, with its cause and fix

## Explanation

Why it works the way it does.

- [How sync works](explanation/sync.md)
- [Keys and identity](explanation/keys-and-identity.md)
- [Signed updates](explanation/signed-updates.md)
- [Size budgets](explanation/size-budgets.md)
- [Known limits](explanation/limits.md)

## How these pages are checked

`npm test` fails if a sample on these pages does not compile against `@trellis/framework`, if a link or heading anchor is broken, or if the API reference and the framework's exports disagree.
