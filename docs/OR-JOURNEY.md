# OR ward journey: OR schedule → OR room → recovery → out of the OR ward

A **session** is a Canopy admission (`canopy_admission`) booked into an OR room. Because of that, the existing pre-op forms, Leaf delivery and HL7 keep working.

Code:
- `services/flora-api/app/or_journey.py`: states and overlap checks
- `services/flora-api/app/or_sessions.py`: database side, shared by the Canopy and sync APIs
- `routes/or_schedule.py`: Canopy
- `routes/or_leaf.py`: Leaf
- Migration: `infrastructure/postgres/0089-or-schedule.sql`

## States (as shown on the OR board)

| journey_state | Label | Meaning |
|---|---|---|
| booked | Appointed | In the schedule (room, start, duration, team, equipment) |
| assigned | Waiting | The ward desk assigned an OR bed; that bed's Leaf lists the patient |
| in_or | Operation | Patient moved in: the case started on the OR room's Leaf |
| awaiting_recovery | Recovery | Moved out of the OR room; the room is free; Canopy holds the case |
| assigned_recovery | Recovery | Recovery bed assigned; that bed's Leaf lists the patient |
| in_recovery | Recovery | Moved in to recovery: the same case continues on the recovery Leaf (start time and chart kept) |
| discharged | Completed | Out of the OR ward, with a destination (ICU, IPD ward, home, …) |
| cancelled, postponed, no_show, miscreate | — | Closed before arrival (with a reason); **Book again** reopens it |

A patient can go from `in_or`, or while waiting for recovery, straight to `discharged`.

## Who does what

- **`or.schedule`** (book and change the schedule): system_admin, clinical_admin.
- **`or.journey`** (assign beds, move in / out, discharge from Canopy): system_admin, clinical_admin, clinician.
- **On a Leaf**, the existing case permissions apply: `case.create` for move in, `case.discharge` for move out and discharge.

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
5. **Move out.** The chart button reads **Move out** in an OR room, or the desk presses **Patient move out**.
   - **Patient Out** is added to the timeline.
   - The case closes on that Leaf with `discharge_reason='moved_out'`. It is not a discharge: infusions keep running.
   - The sync worker sends a final copy, then the room is free.
6. **Recovery.** Drawer (or the Recovery tab) → assign a recovery bed.
   - **Move in** on that bed's Leaf, or requested from the desk, takes the case over through the handover claim.
   - The claim waits until Canopy holds the OR Leaf's final copy (an export whose case status is no longer `active`).
   - The case gets `or_stage='recovery'` and a **Start Recovery** event, and stays linked to its booking.
   - If the import fails, the handover is cancelled and the patient goes back to waiting for that bed.
7. **Discharge.** The Leaf's discharge dialog asks for the destination, or the desk presses Discharge with a destination. The session becomes Completed, with the destination.

Every step is written to `canopy_session_event` (the drawer's History) and to `canopy_patient_movement` (the Digital twin). The OR room's Leaf keeps reporting its closed case for a while; Canopy ignores those reports (`handed_from_leaf_id`) instead of flagging a conflict.

## Demo: several OR-suite workstations on one screen

`./demo/workstations.sh up` starts two lean Leaf stacks next to OR-1, on the shared docker network `flora-demo-leaves`:
- **OR-2** (`leaf-or-02`, API on :7361) in Operating Room 2
- **Recovery** (`leaf-recovery-01`, API on :7371) in OR1 Recovery

It then runs `python -m app.demo_or_workstations kcmh` in canopy-api. That creates the rooms and beds if they are missing, sets the room types and assigns each Leaf to its bed. Run `./demo/workstations.sh assign` again if a Leaf had not synced yet.

To use them, open any Leaf web (dev build, e.g. http://localhost:7300). The **Demo workstation** picker on the login page and in the user menu switches which Leaf the screen talks to. Every switch signs out: log in again with a Canopy user. The list is in `frontend/src/demo/workstations.ts`. The picker shows only in dev builds, or when `VITE_FLORA_DEMO_WORKSTATIONS=1`.

Other commands: `./demo/workstations.sh status` and `./demo/workstations.sh down` (add `-v` to drop their databases).
