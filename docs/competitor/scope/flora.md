# System scope: FLORA (ESM / SmartCIS) — self-assessment from repo, updated 2026-10-26

> **Update 2026-10-26:** gateway EKG/waveform (M540), live streaming, ICU scheduled rounds, scoring engine, transfer, OR schedule added. **Release caveat:** these are in source on `main` but newer than the pinned releases (leaf-1.2.9, gateway-0.2.4); live services are an opt-in compose profile and scheduled forms need migration 0097 — not yet in a signed release.

Legend: ✅ implemented · ◐ partial / in progress · ❌ not present · ? unclear. Evidence paths are relative to the repo root.
Tiers: Leaf (bedside/OR, offline, own PostgreSQL) · Canopy (central view + config, Haber release/licensing) · Gateway (Rust + Python + Kafka) · Root (cloud tenants/licences/releases).

## A. Clinical workflow coverage
| # | Item | Status | Notes | Evidence |
|---|---|---|---|---|
| A1 | Pre-anesthesia assessment | ✅ | Pre-anesthesia tab: consent, NPO, airway (Mallampati, MO, TMD, neck, dentition), functional capacity, GCS, baseline vitals, Hb/Hct/glucose, premed, risk; HIS patient/allergy/lab preload | `frontend/src/views/FormView.tsx` (tab `preop`); `services/flora-api/app/routes/his.py` |
| A2 | Consent / pre-op checklist | ✅ | Consent fields + checklist item; readiness cards on case start. No e-signature consent document | `FormView.tsx`; `frontend/src/views/IdleCaseLanding.tsx` |
| A3 | WHO surgical safety checklist | ◐ | 16-item anesthesia safety checklist + time-out block and timeline event; not WHO sign-in/time-out/sign-out phases with per-phase sign-off | `FormView.tsx`; `ClinicalChartView.tsx` |
| A4 | Intra-op auto vitals capture | ✅ | `device_writer` minute windows → `vital_minutes`, audited; live timeline + trends; device provenance | `services/flora-api/app/device_writer.py`; `ClinicalChartView.tsx`; `0022-timeline-device-provenance.sql` |
| A5 | Drugs, fluids, blood, gases, events, airway | ✅ | Bolus, drips (runs/segments), blood, fluids, outputs, events, ECG rhythm; airway tabs GA ETT/LMA/tubeless/neuraxial/PNB/lines/extubation | `routes/io_write.py`; `routes/clinical_write.py`; `components/io/*` |
| A6 | Anesthesia machine / ventilator capture | ✅ | GE Carestation (COM 1.2, DRI), Dräger MEDIBUS.X; vent settings + alarm limits | `flora-gateway/python/device-medical-service/.../parsers/ge/carestation/`, `parsers/draeger/medibus/` |
| A7 | PACU / recovery | ✅ | 5-item Aldrete-style score /10 (≥9 highlight), pain, PONV, temp, drains, complications, discharge; no PADSS | `FormView.tsx` |
| A8 | Post-op visit / pain service | ◐ | Pain tab inside case; no multi-day APS rounds workflow | `FormView.tsx` (`pain*`) |
| A9 | ICU flowsheet | ✅ | Same Leaf chart for ICU beds; **long stays 14–30 days** (Day-N windows, last-24 h default, print range); **multi-case per Leaf** (bed_label, one Leaf → several ICU beds); live 1-s numerics strip; Canopy ICU overview | `ClinicalChartView.tsx`; `views/clinical-chart/dayWindow.ts`; `components/live/LiveStrip.tsx`; `0090-leaf-live-stream.sql` |
| A10 | ICU nursing assessment / care plan | ◐ | **New engine:** scheduled workflow forms (daily / every N h / per shift), due/overdue/skip, per-case worklist, Ward badges, sync + handover. ICU content v2 (daily round, SOFA, brain bundle, per-shift VAP check) **not yet imported/published** (seed = draft); no care-plan / nursing-diagnosis module | `docs/ICU-ROUNDS.md`; `app/form_schedule.py`; `0097-case-form-entry.sql`; `components/workflow/ScheduledFormPanel.tsx`; `docs/icu-workflows/` |
| A11 | Orders / MAR / infusion | ◐ | Administration recording + B. Braun SpaceCom read; **no CPOE / MAR schedule / pharmacy verification** | `routes/io_write.py`; `parsers/bbraun/bcc/`; `docs/BRKidney-HIS-Drug-Order-Software-Spec.md` (spec only) |
| A12 | Fluid balance (I/O) | ✅ | Full I/O view, balance summaries, groups, audit | `views/InputOutputBalanceView.tsx`; `0016-io-group-master.sql` |
| A13 | ICU scoring | ◐ | **Scoring engine `flora-score/1`:** ScoreWriter auto-computes NEWS2, MEWS, qSOFA, GCS every 60 s from vitals (Σ rows on chart, versioned, synced); Score Studio; Aldrete manual. SOFA form formula; **APACHE II still manual** | `docs/SCORING.md`; `app/scoring.py`, `score_writer.py`; `0084-scoring.sql`; `components/workflow/ScoreStudio.tsx` |
| A14 | Physician / progress notes | ◐ | ICU daily round as scheduled entry (07:00, one per day; form v2 unpublished), event notes, ICD-10/9, offline dictation; no structured SOAP module | `docs/ICU-ROUNDS.md`; `routes/clinical_write.py`; `routes/dictation.py` |
| A15 | Lab / imaging results | ◐ | HIS lab sync with abnormal/critical filter; no imaging/PACS viewer | `views/LabView.tsx`; `routes/his.py` |
| A16 | Handover / transfer summary | ◐ | **Transfer without discharge:** Leaf→Leaf (offer/receive, also from Canopy ward desk), bed move on same Leaf, device re-binding; OR→recovery transfer; Patient Journey; handover carries form entries + scores. No nursing shift report; ISBAR form draft | `app/case_transfer.py`; `0091`/`0094`/`0095-*transfer.sql`; `components/ward/TransferDialogs.tsx`; `app/patient_journey.py` |
| A17 | General ward / IPD | ◐ | Ward page: active cases per bed, incoming/outgoing transfers, worklist badges; Canopy Admission Hub; no shipped general-ward forms. ER (EDIS) workflows = docs/draft | `views/WardView.tsx`; `views/CanopyAdmissionHubView.tsx`; `docs/er-edis/` |
| A18 | ER / labour room | ❌ | Not shipped (buildable with Studio) | — |

## B. OR / perioperative management
| # | Item | Status | Notes | Evidence |
|---|---|---|---|---|
| B1 | OR scheduling | ✅ | **OR schedule:** book into room × time grid, equipment + team; also HL7 SIU/ORM/ADT and EPHIS import | `docs/OR-JOURNEY.md`; `routes/or_schedule.py`; `0089-or-schedule.sql`; `views/CanopyOrScheduleView.tsx` |
| B2 | OR status board | ✅ | OR states booked → assigned → in_or → recovery → discharged; Leaf OR flow; Patient Journey; Canopy Digital Twin (unit→room→bed live map). ICU bed board, no ICU phase whiteboard | `app/or_journey.py`; `routes/or_leaf.py`; `views/CanopyDigitalTwinView.tsx`; `0088-digital-twin.sql` |
| B3 | Staff / resources | ◐ | Staff directory/profiles, per-case staff, RBAC; no rostering | `views/StaffView.tsx`; `0017-rbac.sql` |
| B4 | Supplies / charge capture | ✅ | OR billing checklist (106 seeded items), fill-from-chart, Billing Template Studio; no implant tracking, no auto HIS posting | `docs/BILLING.md`; `0080-billing.sql`; `routes/billing_*.py` |

## C. Medical device integration
| # | Item | Status | Notes | Evidence |
|---|---|---|---|---|
| C1 | Own gateway | ✅ | Flora Gateway: Rust controllers → Kafka → Python parsers → Postgres; **new Rust `stream-hub`** (WebSocket `/stream/v1`, 1-s chunks, seq/ack, Kafka replay, case↔device binding with audit, per-Leaf tokens); pod demux by source IP. Live stack is opt-in `live` profile | `flora-gateway/rust/crates/stream-hub/`; `docs/live-stream/PROTOCOL.md`; `0092-canopy-case-binding.sql` |
| C2 | Multi-brand | ◐ | 10 parsers (GE DRI, GE CS COM1.2, Dräger MEDIBUS.X, IACS M540, Vista 120 S, B. Braun BCC, generic HL7, Hidro HL7, JSON, ASCII-KV); 3 driver brands; Root catalog 115 models / 25 makers; **0 formally validated** | `flora-gateway/device-types.json`; `flora-root/api/app/reference/device_types.json`; `docs/DEVICE-COMPATIBILITY-CATALOG.md` |
| C3 | Monitors / machines / vents / pumps | ◐ | GE B450/B650/B850/S5, Dräger M540/Vista; GE CS750/Aisys; Dräger Evita/Savina/Babylog/Oxylog/Carina; B. Braun Space. Philips & Mindray = HL7 candidates only | as C2 |
| C4 | Waveform | ◐ | **EKG/waveform capture — Dräger M540 (IACS) only:** wave blocks → Kafka `gw.wave` → stream-hub → Leaf `stream_wave` (7-day retention); Leaf Waveform page (sweep 12.5/25/50 mm/s) labelled "not for diagnosis or alarms"; sample rate unverified on real captures; no Canopy waveform view; no other brands | `parsers/draeger/iacs_m540/parser.py`; `services/flora-api/app/live/`; `frontend/src/views/WaveformView.tsx` |
| C5 | Alarm / surveillance | ◐ | Gateway connectivity alerts (Canopy + Leaf), per-device stream health (lag, gaps); **no clinical alarm forwarding** | `routes/gateway_alerts.py`; `LiveStrip.tsx` |

## D. HIS / interoperability
| # | Item | Status | Notes | Evidence |
|---|---|---|---|---|
| D1 | HL7 v2 | ◐ | Inbound SIU/ORM/ADT via interface engine; device HL7 over MLLP; **no outbound ORU/DFT, no inbound ORU** | `app/hl7_interface.py` |
| D2 | FHIR | ◐ | Demo-only FHIR R4 / PDQm fixtures; production public REST API + MCP (not FHIR) | `docs/DEMO-HIS-EXCHANGE.md`; `routes/public_api.py`; `services/flora-mcp/` |
| D3 | PDF to HIS | ◐ | Case packet PDF, form PDF, Innovian archive PDF; auto-push to ePHIS scoped only | `components/workflow/casePacket.ts`; `electron/reportPdf.cjs` |
| D4 | Thai HIS | ✅ | KCMH in-house HIS (patient/allergy/lab), EPHIS import, Scope-Life HL7; Porjai/Abstract spec; no HOSxP | `routes/his.py`; `routes/ephis.py` |

## E. CDS & analytics
| # | Item | Status | Notes | Evidence |
|---|---|---|---|---|
| E1 | Alerts / bundles | ◐ | NEWS2/MEWS/qSOFA bands + flags on chart (~1 min, decision support, not pushed alarms); VAP per-shift scheduled check with due/overdue (once published); bundle forms draft | `docs/SCORING.md`; `app/score_writer.py`; `app/form_schedule.py` |
| E2 | Drug interaction / dosing | ❌ | Allergy-reviewed tick only; drip calc utils | `utils/medicationDrip.ts` |
| E3 | Dashboards / QI / reports | ✅ | Canopy reports, Report Studio, AI Studio dashboards, ICU overview, **Digital Twin**, Activity Log, worklist badges | `reportstudio/*`; `views/CanopyDigitalTwinView.tsx`; `views/CanopyActivityLogView.tsx` |
| E4 | Research / export | ✅ | Query builder w/ audit, CSV/XLSX, case export, Innovian archive, PHI-masked public API, MCP | `routes/formdev_query.py`; `routes/public_api.py`; `app/phi_mask.py` |
| E5 | AI | ✅ | AI Studio (aggregate/non-identifying), offline STT (faster-whisper), LLM dictation-to-form, MCP | `routes/ai_studio.py`; `services/flora-stt/`; `routes/dictation.py` |

## F. Configurability
| # | Item | Status | Notes | Evidence |
|---|---|---|---|---|
| F1 | Form builder | ✅ | Form Studio — hospital admins can build (logic, calculators, versioning, packs, offline, PDF) | `frontend/src/formdev/designer/*` |
| F2 | Report builder | ✅ | Report Studio + AI Studio | `frontend/src/reportstudio/` |
| F3 | Workflow / rules | ✅ | Workflow Studio per ward, import/export; terminology, masters, themes, languages | `docs/workflow-studio.md`; `0070-workflow-studio.sql` |

## G. Technical
| # | Item | Status | Notes | Evidence |
|---|---|---|---|---|
| G1 | Architecture | ✅ | FastAPI, React 19/TS, PostgreSQL (~80 migrations), Electron (Windows), Rust/Kafka/Kong gateway, Docker Compose | `docs/BACKEND-ARCHITECTURE.md` |
| G2 | Deployment | ✅ | Hybrid: on-prem Leaf/Canopy/Gateway + cloud Root; signed releases, hospital-approved rollout | `docs/DEPLOYMENT.md`; `flora-root/README.md` |
| G3 | Offline at bedside | ✅ | Offline-first Leaf with own DB, local Ward page, sync on reconnect, local STT | `services/flora-sync-worker`; `formdev/offline/*` |
| G4 | Mobile / web | ◐ | Web + Electron; no native mobile app | `flora-edge/nginx.conf` |
| G5 | Thai UI | ✅ | th/en, bilingual forms, Thai PHI masking | `context/LanguageContext.tsx`; `0010-language-translations.sql` |
| G6 | Security / certifications | ◐ | RBAC, audit, PHI masking, Ed25519-signed licences/releases; **no FDA/CE/ISO 13485/IEC 62304/Thai FDA** | `docs/ACCESS-CONTROL.md` |

## H. Commercial
| # | Item | Status | Notes | Evidence |
|---|---|---|---|---|
| H1 | Licensing | ◐ | Root licence bundle per hospital (modules, max Leaves/gateways/devices/device types); editions Full / RCAT Community / E-for-L Partner; commercial terms not in repo | `docs/FLORA-Edition-Architecture-Plan.md` |
| H2 | Project components | ◐ | Gateway hardware comparison, reference deployment, training flow, troubleshooting guides, tech-transfer register | `docs/DEPLOYMENT.md`; `docs/FLORA-User-Training-Flow.md` |
| H3 | Price points | ? | None in repo | — |

## Summary
- **Strongest:** anesthesia/OR record end to end plus OR schedule/journey; live 1-s streaming with EKG (M540); ICU infrastructure (scheduled rounds, auto NEWS2/MEWS/qSOFA/GCS, transfer, multi-bed Leaf); hospital-side Form/Workflow/Report Studio; AI Studio + offline Thai/English STT; offline-first architecture; Thai UI; real KCMH HIS/EPHIS integration; OR charge capture.
- **Weakest:** device breadth (3 driver brands, 0 formally validated, no Philips/Mindray driver; waveform only M540, no alarm surveillance); ICU content still draft/unpublished; new ICU/EKG code not yet in a signed release; no CPOE/MAR, drug checks, real-time CDS; no outbound HL7 / production FHIR; no regulatory certification.
- Repo inconsistencies: `DEVICE-COMPATIBILITY-CATALOG.md` predates the MEDIBUS.X parser; ICU/Workflow Studio Leaf code may not be in leaf-1.2.x releases.
