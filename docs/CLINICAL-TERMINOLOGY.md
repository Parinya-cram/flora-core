# Flora clinical terminology model

Flora keeps the clinician-entered local wording as the historical case record. Standard codes are optional mappings and never replace or silently rewrite that wording.

## Data model

- `clinical_concept` stores the stable local ID and local name for one domain: observation, medication, fluid, blood product, output, diagnosis or procedure.
- `clinical_concept_coding` stores any number of terminology mappings. Supported systems are SNOMED CT, ICD-10, ICD-9-CM, LOINC, RxNorm, ATC and UCUM.
- `terminology_release` records the edition, version, source and license of every imported standard package.
- `terminology_entry` and `terminology_synonym` provide the searchable reference catalog. A selected entry is linked to the local concept; it does not replace the clinician-entered case text.
- `clinical_parameter_master` maps observation chart keys such as `hr` or `et_agent` to a concept and unit. It is also the authoritative chart/table presentation registry: short label, row group, order, table visibility, chart series/style and default chart visibility.
- `io_group_master` stores configurable medication, fluid and output groups.
- `io_item_master.concept_id` links the operational live-chart catalog to each clinical concept; `group_id` and `default_unit` are managed from the same Clinical Codes screen.
- `case_diagnosis.concept_id` and `case_procedure.concept_id` optionally link case entries to a concept.
- `coding_snapshot` on diagnosis and procedure stores the mappings used at charting time. Later master-data edits therefore do not change an old case.

## Standards by clinical domain

| Domain | Primary mappings |
| --- | --- |
| Observation | SNOMED CT meaning, LOINC observation code, UCUM unit |
| Blood product | SNOMED CT product meaning, UCUM volume unit |
| Medication | SNOMED CT clinical drug, RxNorm and/or ATC |
| Fluid/output | SNOMED CT meaning and UCUM unit |
| Diagnosis | Local code/name, SNOMED CT and ICD-10 |
| Procedure | Local code/name, SNOMED CT, ICD-10 where applicable, and retained ICD-9-CM compatibility |

HL7 v2 and FHIR are exchange formats rather than code systems. An integration should serialize these mappings as FHIR `Coding`/`CodeableConcept` values or the corresponding HL7 v2 coded element while retaining the local coding alongside the standard coding.

## Compatibility rule

Existing cases continue to render from their saved local text. A missing `concept_id` means “not mapped yet,” not invalid data. Migration `0012-clinical-terminology.sql` backfills safe links for existing I/O masters and case diagnosis/procedure entries without deleting or renaming clinical data.

## Reference catalog imports

Migration `0018-terminology-releases.sql` adds the versioned catalog. Load the redistributable baseline with:

```powershell
python scripts/import-terminology.py public-baseline --database-url $env:FLORA_DATABASE_URL
```

That baseline contains WHO ICD-10 2019 diagnoses, ICD-9-CM Volume 3 procedures (CMS version 32, the final ICD-9-CM release), and UCUM 2.2 units. It also creates one editable local Diagnosis or Procedure concept for every active ICD entry. The ICD display becomes the initial local name, while the source code, display, release version and catalog-entry link remain attached as standard coding metadata. Hospital-authorized additions use explicit import commands:

```powershell
python scripts/import-terminology.py generic --database-url $env:FLORA_DATABASE_URL --source terminology-packages/icd10tm.tsv --system ICD_10_TM --system-uri http://hl7.org/fhir/sid/icd-10 --edition Thailand --version YOUR_RELEASE --domain diagnosis
python scripts/import-terminology.py snomed-rf2 --database-url $env:FLORA_DATABASE_URL --source terminology-packages/SnomedCT_InternationalRF2.zip --edition International --version YOUR_RELEASE
```

Do not commit terminology source packages. SNOMED CT must be obtained through the appropriate member licensing and distribution service. ICD-10-TM must be the hospital-approved Thai edition; US ICD-10-CM is not a substitute. UCUM is a unit system and must never be offered as a diagnosis or procedure code.

The admission workflow searches this catalog after two typed characters. Choosing a result stores both the clinician-facing wording and a versioned terminology link in the case coding snapshot. Free text remains available when no suitable standard code exists.

After loading the reference catalog, map the existing Flora local masters:

```powershell
python scripts/map-existing-clinical-standards.py --database-url $env:FLORA_DATABASE_URL
```

The mapper adds exact RxNorm ingredient and ATC mappings for medications, reviewed LOINC mappings for observations and outputs, reviewed SNOMED CT product mappings for blood products, and normalized UCUM units. It reports unresolved local concepts for clinical review. A unit mapping alone is not treated as proof that the fluid, product or observation meaning has been mapped.

## Configuration ownership

Config → Clinical Codes owns terminology and standard mappings. Config → Chart layout separately controls which active observation parameters appear in the live chart and table, including labels, groups and order. The live chart shows a read-only legend; configuration controls are never mixed into the clinical workspace. The case screen reads this registry from PostgreSQL; its built-in list is only an offline fallback. Medication groups and the operational group/default-unit fields remain with Clinical Codes. Saving a medication, fluid, blood-product or output concept creates or updates its `io_item_master` row, so the live I/O workflow consumes the same master. The former separate Fluid & Med configuration menu is intentionally removed.

## Thai Medicines Terminology (TMT)

Migration `0100-med-orders-mar.sql` adds `TMT` and `TMLT` (Thai Medical Laboratory Terminology) to the `clinical_concept_coding.system_key` CHECK. `terminology_release.system_key` has no CHECK. TMT is distributed by THIS as concept tables per level: SUBS, VTM, GP, GPU, TP and TPU. Medication orders normally code at **GPU** (generic product + unit of use) or **TPU** (trade product + unit of use).

Combine the levels you need into one CSV or TSV with the columns `tmtid, fsn, level` (optionally `fsn_th`) and import it as a release:

```powershell
python scripts/import-terminology.py tmt --database-url $env:FLORA_DATABASE_URL --source terminology-packages/tmt_gpu_tpu.csv --version 20260901
python scripts/import-terminology.py tmt-map --database-url $env:FLORA_DATABASE_URL --source terminology-packages/item_tmt.csv
```

- `tmt` loads `terminology_entry` rows with domain `medication` and the level in `metadata.level`.
- `tmt-map` reads a CSV with the columns `item_code, tmtid`. It links catalogue drugs (`io_item_master.code`, `kind='med'`, which must already have a `concept_id`) by adding `TMT` codings.
- A TMT entry can also be linked to a medication concept from Config → Clinical Codes.

The medication order search (`GET /api/case/med-catalog?q=`) matches the drug name, the item code, or any coding (TMT, SNOMED CT, ...). It also offers active TMT entries that are not yet in the catalogue, for a free-text order coded with TMT only. An order keeps a `codings` snapshot (`[{system, code, display}]`: TMT, SNOMED_CT, HIS) taken at order time. Do not commit TMT source files.
