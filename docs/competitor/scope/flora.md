# System scope: FLORA (ESM / SmartCIS) — self-assessment from repo, 2026-10-13

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
| A9 | ICU flowsheet | ✅ | Same Leaf chart for ICU beds; Canopy ICU overview, multi-bed monitoring | `ClinicalChartView.tsx`; `routes/fleet_read.py`; `CanopyDashboardView.tsx` |
| A10 | ICU nursing assessment / care plan | ◐ | Form Studio ICU packs (admission, daily round FAST HUGS BID/RASS/CAM-ICU/CPOT, lines, brain bundle, Thai nursing assessment) — **draft, unpublished**; no care-plan / nursing-diagnosis module | `docs/icu-workflows/`; `formdev/packs/patient-assessment.v2.formpack` |
| A11 | Orders / MAR / infusion | ◐ | Administration recording + B. Braun SpaceCom read; **no CPOE / MAR schedule / pharmacy verification** | `routes/io_write.py`; `parsers/bbraun/bcc/`; `docs/BRKidney-HIS-Drug-Order-Software-Spec.md` (spec only) |
| A12 | Fluid balance (I/O) | ✅ | Full I/O view, balance summaries, groups, audit | `views/InputOutputBalanceView.tsx`; `0016-io-group-master.sql` |
| A13 | ICU scoring | ◐ | GCS, SOFA, qSOFA, ICH, CPP, P/F, PBW, driving pressure calculated (draft forms); APACHE II manual | `frontend/src/formdev/logic/calculators.ts` |
| A14 | Physician / progress notes | ◐ | Event notes, daily round plan, ICD-10/9 diagnosis, offline voice dictation; no structured SOAP module | `routes/clinical_write.py`; `views/DiagnosisView.tsx`; `routes/dictation.py` |
| A15 | Lab / imaging results | ◐ | HIS lab sync with abnormal/critical filter; no imaging/PACS viewer | `views/LabView.tsx`; `routes/his.py` |
| A16 | Handover / transfer summary | ◐ | ISBAR transfer summary (draft); Leaf-to-Leaf case handover; no nursing shift report | `app/case_handover.py`; `routes/ward.py` |
| A17 | General ward / IPD | ◐ | Ward-agnostic workflows, Ward page, Morse; no shipped general-ward forms | `views/WardView.tsx`; `docs/workflow-studio.md` |
| A18 | ER / labour room | ❌ | Not shipped (buildable with Studio) | — |

## B. OR / perioperative management
| # | Item | Status | Notes | Evidence |
|---|---|---|---|---|
| B1 | OR scheduling | ◐ | Prepared patients from HL7 SIU/ORM/ADT or EPHIS TSV; no booking calendar | `app/hl7_interface.py`; `routes/canopy_admissions.py`; `routes/ephis.py` |
| B2 | OR status board | ◐ | Canopy central monitoring per bed/room, live case, vitals; not a phase whiteboard | `CanopyDashboardView.tsx`; `CanopyFleetView.tsx` |
| B3 | Staff / resources | ◐ | Staff directory/profiles, per-case staff, RBAC; no rostering | `views/StaffView.tsx`; `0017-rbac.sql` |
| B4 | Supplies / charge capture | ✅ | OR billing checklist (106 seeded items), fill-from-chart, Billing Template Studio; no implant tracking, no auto HIS posting | `docs/BILLING.md`; `0080-billing.sql`; `routes/billing_*.py` |

## C. Medical device integration
| # | Item | Status | Notes | Evidence |
|---|---|---|---|---|
| C1 | Own gateway | ✅ | Flora Gateway: Rust controllers (serial, socket/MLLP/UDP, webhook) → Kafka → Python parsers → Postgres; admin UI; licensed via Root/Haber | `flora-gateway/README.md`; `docs/gateway-manual/` |
| C2 | Multi-brand | ◐ | 10 parsers (GE DRI, GE CS COM1.2, Dräger MEDIBUS.X, IACS M540, Vista 120 S, B. Braun BCC, generic HL7, Hidro HL7, JSON, ASCII-KV); 3 driver brands; Root catalog 115 models / 25 makers; **0 formally validated** | `flora-gateway/device-types.json`; `flora-root/api/app/reference/device_types.json`; `docs/DEVICE-COMPATIBILITY-CATALOG.md` |
| C3 | Monitors / machines / vents / pumps | ◐ | GE B450/B650/B850/S5, Dräger M540/Vista; GE CS750/Aisys; Dräger Evita/Savina/Babylog/Oxylog/Carina; B. Braun Space. Philips & Mindray = HL7 candidates only | as C2 |
| C4 | Waveform | ❌ | Numerics only (minute rows) | `flora-gateway/DRAEGER.md` |
| C5 | Alarm / surveillance | ◐ | Gateway connectivity alerts to Canopy with ack; no clinical alarm forwarding | `routes/gateway_alerts.py`; `0043-canopy-gateway-alerts.sql` |

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
| E1 | Alerts / bundles | ◐ | Bundle forms (Sepsis, VAP, CLABSI/CAUTI, Brain, FAST HUGS) draft; form logic engine; no real-time CDS alerts | `docs/icu-workflows/`; `formdev/logic/*` |
| E2 | Drug interaction / dosing | ❌ | Allergy-reviewed tick only; drip calc utils | `utils/medicationDrip.ts` |
| E3 | Dashboards / QI / reports | ✅ | Canopy reports, Report Studio, AI Studio dashboards, ICU overview | `reportstudio/*`; `routes/canopy_reports.py` |
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
- **Strongest:** anesthesia/OR record end to end; hospital-side Form/Workflow/Report Studio; AI Studio + offline Thai/English STT; offline-first architecture; Thai UI; real KCMH HIS/EPHIS integration; OR charge capture.
- **Weakest:** device breadth (3 driver brands, 0 formally validated, no Philips/Mindray driver, no waveform/alarm surveillance); ICU forms still draft; no CPOE/MAR, drug checks, real-time CDS; no outbound HL7 / production FHIR; no regulatory certification.
- Repo inconsistencies: `DEVICE-COMPATIBILITY-CATALOG.md` predates the MEDIBUS.X parser; ICU/Workflow Studio Leaf code may not be in leaf-1.2.x releases.
