# OR ward journey: OR schedule → OR room → recovery → out of the OR ward

A **session** is a Canopy admission (`canopy_admission`) booked into an OR room. Because of that, the existing pre-op forms, Leaf delivery and HL7 keep working.

Code:
- `services/flora-api/app/or_journey.py`: states and overlap checks
- `services/flora-api/app/or_sessions.py`: database side, shared by the Canopy and sync APIs
- `routes/or_schedule.py`: Canopy
- `routes/or_leaf.py`: Leaf
- `services/flora-api/app/patient_journey.py`, `routes/case_journey.py`: Patient Journey
- Migrations: `infrastructure/postgres/0089-or-schedule.sql`, `0091-or-transfer.sql` (transfer billing)

## States (as shown on the OR board)

| journey_state | Label | Meaning |
|---|---|---|
| booked | Appointed | In the schedule (room, start, duration, team, equipment) |
| assigned | Waiting | The ward desk assigned an OR bed; that bed's Leaf lists the patient |
| in_or | Operation | Patient moved in: the case started on the OR room's Leaf |
| awaiting_recovery | Recovery | Transferred out of the OR room: the OR case is closed, the room is free |
| assigned_recovery | Recovery | Recovery bed assigned; that bed's Leaf lists the patient |
| in_recovery | Recovery | Transfer received: a new Post-Anesthesia case runs on the recovery Leaf (same AN) |
| discharged | Completed | Out of the OR ward, with a destination (ICU, IPD ward, home, …) |
| cancelled, postponed, no_show, miscreate | — | Closed before arrival (with a reason); **Book again** reopens it |

A patient can go from `in_or`, or while waiting for recovery, straight to `discharged`.

## Who does what

- **`or.schedule`** (book and change the schedule): system_admin, clinical_admin.
- **`or.journey`** (assign beds, move in, transfer, billing mode, discharge from Canopy): system_admin, clinical_admin, clinician.
- **On a Leaf**, the existing case permissions apply: `case.create` for move in, `case.discharge` for transfer and discharge.

## Flow

1. **Book.** Canopy → OR schedule → Schedule. The grid shows OR rooms against time in 15-minute slots.
   - Drag a booking to move it, drag its end to resize it, or click an empty slot to book.
   - Room and staff overlaps are flagged but not blocked.
   - The other tabs are List (the desk's day list), Board (status colours), Recovery, and Setup (room types, OR types, equipment).
2. **Pre-op.** The admission's existing pre-op form.
3. **Assign.** Drawer → Receive the patient → choose a bed in an OR room. The booking reaches only that bed's Leaf, as `or_session` in the admission header. An OR booking never goes to every Leaf of the ward.
4. **Move in.** Press **Move in** on the Leaf's Ward page, or **Patient move in** at the desk (the Leaf then does it at its next sync). Either way:
   - the case starts with `or_stage='or'`;
   - **Patient In** is added to the timeline;
   - the booked team becomes the case staff (directory people by staff code; others by name).
5. **Transfer to Recovery.** The chart button reads **Transfer to Recovery** in an OR room, or the desk presses **Transfer to Recovery**.
   - The OR and Recovery charts are separate records: the OR case prints as the **Anesthesia Report**, the recovery case as the **Post-Anesthesia (PACU) report**.
   - **Patient Out** is added to the timeline ("Transfer to recovery").
   - The OR case closes on that Leaf with `discharge_reason='transferred'`, destination `recovery`. Running infusions are stopped on this chart at the transfer time.
   - The transfer dialog asks for **Billing**: *Combined* (OR + Recovery one bill, default) or *Separate*. The desk can change it until the patient is in recovery (`POST …/sessions/{id}/billing-mode`).
   - The sync worker sends a final copy; Canopy keeps the OR case's id in `canopy_admission.or_global_case_id`. The room is free.
6. **Recovery.** Drawer (or the Recovery tab) → assign a recovery bed.
   - **Receive transfer** on that bed's Leaf (Ward page), or requested from the desk, **starts a new case** for the same admission: `or_stage='recovery'`, a **Start Recovery** event ("Transferred from the OR").
   - Canopy hands the booking to the recovery Leaf (`or_sessions.transfer_claim`); the OR Leaf becomes `handed_from_leaf_id`.
   - Infusions that were running in the OR show on the new chart as a **continuing medications** banner and in **Patient Journey**; the recovery nurse restarts the ones still running.
7. **Discharge.** The Leaf's discharge dialog asks for the destination, or the desk presses Discharge with a destination. The session becomes Completed, with the destination.

Every step is written to `canopy_session_event` (the drawer's History) and to `canopy_patient_movement` (the Digital twin). The OR room's Leaf keeps reporting its closed case for a while; Canopy ignores those reports (`handed_from_leaf_id`) instead of flagging a conflict.

## Demo: several OR-suite workstations on one screen

`./demo/workstations.sh up` starts two lean Leaf stacks next to OR-1, on the shared docker network `flora-demo-leaves`:
- **OR-2** (`leaf-or-02`, API on :7361) in Operating Room 2
- **Recovery** (`leaf-recovery-01`, API on :7371) in OR1 Recovery

It then runs `python -m app.demo_or_workstations kcmh` in canopy-api. That creates the rooms and beds if they are missing, sets the room types and assigns each Leaf to its bed. Run `./demo/workstations.sh assign` again if a Leaf had not synced yet.

To use them, open any Leaf web (dev build, e.g. http://localhost:7300). The **Demo workstation** picker on the login page and in the user menu switches which Leaf the screen talks to. Every switch signs out: log in again with a Canopy user. The list is in `frontend/src/demo/workstations.ts`. The picker shows only in dev builds, or when `VITE_FLORA_DEMO_WORKSTATIONS=1`.

Other commands: `./demo/workstations.sh status` and `./demo/workstations.sh down` (add `-v` to drop their databases).

## Patient Journey (Leaf)

A case page (sidebar **Journey**) listing the other cases of the same AN on other workstations — OR → Recovery → ICU — oldest first, read from Canopy's case exports (`POST /api/sync/v1/journey`, called by the Leaf's `GET /api/case/{id}/journey`).

- Per case: stage (OR · Anesthesia / Recovery · Post-Anesthesia / ward), workstation, times, how it ended, allergies, infusions, doses, events, last vitals.
- Infusions are **Continuing** when they were still running at the end of that case (stopped at, or within a minute of, the hand-off), **Running** on a case still open, else **Stopped**.
- The chart shows the previous case's continuing infusions at the top, like the orders seen on an ICU round.
- Cases without an AN are not linked.

## Billing of a transfer (Canopy → Billing)

With *Combined* billing the OR and Recovery orders appear as one row ("OR + Recovery"): amounts and item counts are summed, the status is submitted only when both are. The detail lists OR lines, then Recovery lines; the printed sheet sums the same item. *Separate* keeps two rows.
