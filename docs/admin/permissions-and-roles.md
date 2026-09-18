# Permissions and roles

Reference for the administrator of a deployment. Lists the three roles and what
each one may do.

Every user has exactly one role, set when they are invited and changeable from
their user page. There is no per-user permission editing: the role decides
everything.

| Permission | `ADMIN` | `SUPERVISOR` | `AGENT` |
|---|---|---|---|
| `calls:view` | yes | yes | yes |
| `calls:manage` | yes | yes | yes |
| `calls:transfer` | yes | yes | yes |
| `calls:viewAll` | yes | yes | — |
| `recordings:listen` | yes | yes | — |
| `users:view` | yes | yes | — |
| `users:manage` | yes | — | — |
| `departments:view` | yes | yes | — |
| `departments:manage` | yes | — | — |
| `internal:access` | yes | — | — |
| `reports:view` | yes | yes | — |
| `settings:manage` | yes | — | — |

In short:

- **Agents** make and take calls, transfer them, and work the threads on their own lines. They cannot hear call recordings, and their call history does not mention them.
- **Supervisors** additionally see every call and can play call recordings.
- **Admins** additionally run the console: users, departments, phone numbers and the deployment's settings.

The table itself lives in `packages/events`, shared by the API, the web app and
the call controller.

## Related

- [Users and invites](users-and-invites.md)
- [Recording retention](recording-retention.md) — what `recordings:listen` gates
