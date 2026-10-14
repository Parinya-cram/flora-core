# Staff directory: Canopy and Leaf

Canopy owns the hospital staff directory. Each Leaf receives the staff of its ward and can add people, who go up to Canopy.

## The rules

**Identity**
- `staff_code` (the doctor or nurse code) identifies a person on every node. It is compared without regard to case and unique per node.
- Doctor and nurse roles must have a code. The role type is `staff_role.staff_type` and is set in Canopy → Staff directory → Roles.
- People in other roles may have no code. They then stay on their Leaf and are not synced.

**Canopy → Leaf**
- A Leaf receives every active, coded person in its ward (`staff_directory_unit`), plus `all_units` staff, plus the roles.
- On the Leaf these records are `directory_managed` and read-only. The API answers 409, and the screen tells the user to make the change in Canopy.
- When someone is deactivated in Canopy or removed from the ward, they become inactive on the Leaf. Past cases keep their names, because `case_staff` is a copy.

**Leaf → Canopy**
- When someone is added on the Leaf with a code, the entry becomes `directory_pending` and is sent on the next sync. The same happens when a coded person is first typed into a case. Canopy then does one of three things:
  - **merged:** Canopy already has the code. Canopy's record wins: it adds the Leaf's ward to that person and sends its data back down, replacing the Leaf entry.
  - **created:** the code is new. Canopy creates the person for the Leaf's ward, with `origin_leaf` set and `needs_review` flagged for an administrator to check.
  - **rejected:** Canopy cannot take the entry, for example because the same name and role already has a different code. The reason is kept in `sync_error` and shown on the Leaf, where it can be fixed and saved again.
- On the Leaf, adding a code that another person already uses returns 409.

**Login users**
- A user's linked staff profile (`auth_user.staff_directory_id`) travels as the staff code inside the user directory exchange. Each node turns the code back into its own id.
- The link can be set in Canopy (Users) or on a Leaf (Users, with the admin PIN). The newest change wins, as for other user fields.

## Pieces

- **Migration** `infrastructure/postgres/0085-staff-sync.sql`:
  - `staff_role.staff_type`, plus the 12 roles the Leaf already used (until now the table was empty, so saving staff failed);
  - new `staff_directory` columns: `staff_code`, `all_units`, `directory_version`, `directory_pending`, `directory_managed`, `sync_error`, `origin_leaf`, `needs_review`;
  - `case_staff.staff_code`;
  - the `staff_directory_unit` table.
- **Sync logic:** `services/flora-api/app/staff_sync.py`.
- **Canopy sync API:** `POST /api/sync/v1/staff` takes `{leaf_id, digest, changes}` and returns `{unit, digest, roles, staff | null, results}`. The `digest` lets it skip sending a ward list that has not changed.
- **Leaf API** (`routes/staff_sync_leaf.py`):
  - `GET /api/case/staff/sync`: status for the Staff screen;
  - `GET …/pending` and `PUT …/apply`: used by the sync worker only.
- **Sync worker:** the `staff` step comes after `directory`. Its result is stored in `leaf_sync_status` and shown on the Ward page and on the Staff screen. **Sync now** uses `POST /api/ward/sync`.
- **Canopy screens:**
  - **Staff directory** (`views/CanopyStaffView.tsx`, needs `staff.manage`): search, filter by ward, role or review, add and edit people, assign wards or all wards, mark reviewed, import a CSV, and edit roles.
  - API routes are in `routes/staff_canopy.py`.
- **Leaf screen:** Settings → Staff (`views/StaffView.tsx`) shows:
  - the sync panel (last sync, result of the last run, what is waiting to go up, Sync now);
  - a badge on each entry: Canopy, Waiting to send, Not accepted, Code needed or Local;
  - a staff code field, required for doctors and nurses.
