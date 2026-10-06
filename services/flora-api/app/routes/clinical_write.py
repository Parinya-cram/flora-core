import json
import hashlib
import re
from typing import Any
from fastapi import APIRouter, Body, Depends, HTTPException
from psycopg import Connection, sql
from psycopg.types.json import Jsonb
from .. import form_sync
from ..database import connection
from ..clinical import insert,update,text,number,timestamp,case_audit
from .auth_leaf import now_ms,require_permission
from .cases_lifecycle import editable_case

router=APIRouter(prefix="/api/case",tags=["clinical entry"])


@router.put("/{case_id}/patient")
def patient(case_id:int,payload:dict=Body(...),actor:dict=Depends(require_permission("case.chart")),database:Connection=Depends(connection)):
    hn=text(payload.get("hn"))
    if not hn: raise HTTPException(400,"hn is required")
    field_map={
        "an":"an","idType":"notype","idCard":"id_card","titleTh":"title_th","titleEn":"title_en",
        "firstName":"first_name","lastName":"last_name","firstNameEn":"first_name_en","lastNameEn":"last_name_en",
        "sex":"sex","dob":"dob","ageText":"age_text","bloodGroupABO":"blood_group_abo",
        "bloodGroupRh":"blood_group_rh","race":"race","ethnicity":"ethnicity","religion":"religion",
        "maritalStatus":"marital_status","presentAddress":"present_address","presentProvince":"present_province",
        "legalAddress":"legal_address","legalProvince":"legal_province","mobile":"mobile","contactName":"contact_name",
        "contactTel":"contact_tel","contactRelation":"relation_desc","nationality":"nationality",
    }
    values={"hn":hn}
    for source,target in field_map.items():
        if source in payload: values[target]=text(payload.get(source))
    if "weightKg" in payload: values["weight_kg"]=number(payload.get("weightKg"),"weightKg",0)
    if "heightCm" in payload: values["height_cm"]=number(payload.get("heightCm"),"heightCm",0)
    display_name=(" ".join(filter(None,(values.get("title_th"),values.get("first_name"),values.get("last_name"))))
        or " ".join(filter(None,(values.get("title_en"),values.get("first_name_en"),values.get("last_name_en")))) or None)
    with database.transaction():
        before_case=editable_case(database,case_id)
        before_patient=database.execute("SELECT * FROM case_his_patient WHERE case_id=%s FOR UPDATE",(case_id,)).fetchone()
        now=now_ms()
        case_values={"hn":hn,"updated_at":now}
        if "an" in values: case_values["admission_number"]=values["an"]
        if display_name: case_values["patient_display_name"]=display_name
        update(database,"cases",case_id,case_values)
        patient_values={**values,"updated_at":now}
        if display_name: patient_values["patient_name"]=display_name
        if before_patient:
            after_patient=update(database,"case_his_patient",before_patient["id"],patient_values)
        else:
            after_patient=insert(database,"case_his_patient",{"case_id":case_id,**patient_values,"source":"MANUAL","created_at":now})
        case_audit(database,case_id,"patient.profile",before_patient,after_patient,actor)
    return {"ok":True,"row":after_patient,"previous_hn":before_case["hn"],"updated_at":now}


def save_draft(db,case_id,draft,actor):
    with db.transaction():
        editable_case(db,case_id)
        old=db.execute("SELECT form_draft_json,field_versions FROM case_detail WHERE case_id=%s FOR UPDATE",(case_id,)).fetchone()
        now=now_ms()
        # Per-field versions let Canopy (tablet) and the Leaf edit the same form; see form_sync.
        versions=form_sync.stamp_changes(form_sync.parse(old and old["form_draft_json"]),draft or {},
                                         (old or {}).get("field_versions") or {},now)
        db.execute("""INSERT INTO case_detail(case_id,created_at,updated_at,form_draft_json,field_versions) VALUES (%s,%s,%s,%s,%s)
            ON CONFLICT(case_id) DO UPDATE SET updated_at=excluded.updated_at,form_draft_json=excluded.form_draft_json,
              field_versions=excluded.field_versions""",
            (case_id,now,now,json.dumps(draft) if draft is not None else None,Jsonb(versions)))
        case_audit(db,case_id,"form.draft",old,draft,actor)
    return {"ok":True,"case_id":case_id,"updated_at":now}


@router.put("/{case_id}/detail-draft")
def draft(case_id:int,payload:dict=Body(...),actor:dict=Depends(require_permission("case.chart")),database:Connection=Depends(connection)):
    if not isinstance(payload.get("draft"),dict): raise HTTPException(400,"draft object required")
    return save_draft(database,case_id,payload["draft"],actor)


@router.patch("/{case_id}/detail-draft")
def patch_draft(case_id:int,payload:dict=Body(...),actor:dict=Depends(require_permission("case.chart")),database:Connection=Depends(connection)):
    patch=payload.get("patch")
    if not isinstance(patch,dict): raise HTTPException(400,"patch object required")
    with database.transaction():
        editable_case(database,case_id)
        row=database.execute("SELECT form_draft_json,field_versions FROM case_detail WHERE case_id=%s FOR UPDATE",(case_id,)).fetchone()
        old={}
        if row and row.get("form_draft_json"):
            try:
                parsed=json.loads(row["form_draft_json"]) if isinstance(row["form_draft_json"],str) else row["form_draft_json"]
                if isinstance(parsed,dict): old=parsed
            except (TypeError,ValueError,json.JSONDecodeError):
                old={}
        merged={**old,**patch}
        now=now_ms()
        versions=form_sync.stamp_changes(old,merged,(row or {}).get("field_versions") or {},now,set(patch))
        database.execute("""INSERT INTO case_detail(case_id,created_at,updated_at,form_draft_json,field_versions) VALUES (%s,%s,%s,%s,%s)
            ON CONFLICT(case_id) DO UPDATE SET updated_at=excluded.updated_at,form_draft_json=excluded.form_draft_json,
              field_versions=excluded.field_versions""",
            (case_id,now,now,json.dumps(merged),Jsonb(versions)))
        case_audit(database,case_id,"form.draft.patch",old,merged,actor)
    return {"ok":True,"case_id":case_id,"updated_at":now,"draft":merged}


@router.delete("/{case_id}/detail-draft")
def clear_draft(case_id:int,actor:dict=Depends(require_permission("case.chart")),database:Connection=Depends(connection)):
    return save_draft(database,case_id,None,actor)


def register_context_routes(path,table,required):
    def values(db,payload,old=None):
        old=old or {}
        name=text(payload.get(required,old.get(required)))
        if not name: raise HTTPException(400,f"{required} required")
        if path=="allergies":
            return {required:name,**{k:text(payload.get(k,old.get(k))) for k in ("reaction","severity")},
                "status":text(payload.get("status",old.get("status"))) or "active",
                "updated_at":now_ms(),"his_updated_at":now_ms()}
        domain="diagnosis" if path=="diagnosis" else "procedure"
        terminology_entry_id=number(payload.get("terminology_entry_id"),"terminology_entry_id",1)
        terminology_entry=None
        if terminology_entry_id:
            terminology_entry=db.execute("""SELECT entry.*,release.system_key,release.system_uri,release.version
              FROM terminology_entry entry JOIN terminology_release release ON release.id=entry.release_id
              WHERE entry.id=%s AND entry.is_active=1 AND release.status='active'""",(int(terminology_entry_id),)).fetchone()
            if not terminology_entry: raise HTTPException(400,"terminology entry not found or inactive")
            if terminology_entry["domain"]!=domain: raise HTTPException(400,"terminology entry does not match entry type")
        code=text(payload.get("icd_code",old.get("icd_code")))
        code=re.sub(r"\s+","",code).upper() if code else None
        version=text(payload.get("icd_version",old.get("icd_version"))) or ("ICD-10" if path=="diagnosis" else "ICD-9") if code else text(payload.get("icd_version",old.get("icd_version")))
        label=text(payload.get("icd_text",old.get("icd_text")))
        if terminology_entry:
            external_system=terminology_entry["system_key"]
            if external_system in {"ICD_10","ICD_10_TM","ICD_10_CM","ICD_10_WHO"}:
                code=terminology_entry["code"]
                version="ICD-10"
                label=terminology_entry["display"]
            elif external_system=="ICD_9_CM":
                code=terminology_entry["code"].replace(".","")
                version="ICD-9"
                label=terminology_entry["display"]
        if code and version=="ICD-10":
            found=db.execute("SELECT coalesce(nullif(name_en,''),name_th) AS name FROM icd10_master WHERE icd10=%s OR icd10who=%s LIMIT 1",(code,code)).fetchone()
            if found: label=found["name"] or label
        elif code and version=="ICD-9":
            code=code.replace(".","")
            found=db.execute("SELECT name_en AS name FROM icd9cm_master WHERE icd9cm=%s LIMIT 1",(code,)).fetchone()
            if found: label=found["name"] or label
        seq=number(payload.get("seq",old.get("seq",1)),"seq",1)
        event_ts=timestamp(payload.get("event_ts",old.get("event_ts")),"event_ts",now_ms())
        default_context="intraoperative" if path=="diagnosis" else "performed"
        entry_context=text(payload.get("entry_context",old.get("entry_context"))) or default_context
        allowed_contexts={"preoperative","intraoperative","postoperative"} if path=="diagnosis" else {"planned","performed"}
        if entry_context not in allowed_contexts: raise HTTPException(400,"invalid entry_context")
        concept_id=number(payload.get("concept_id",old.get("concept_id")),"concept_id",1)
        concept=None
        if concept_id:
            concept=db.execute("SELECT * FROM clinical_concept WHERE id=%s AND domain=%s",(int(concept_id),domain)).fetchone()
            if not concept: raise HTTPException(400,"clinical concept does not match entry type")
        coding_key=None
        coding_code=None
        if terminology_entry:
            coding_key="ICD_10" if terminology_entry["system_key"] in {"ICD_10_TM","ICD_10_CM","ICD_10_WHO"} else terminology_entry["system_key"]
            coding_code=terminology_entry["code"]
            concept=db.execute("""SELECT concept.* FROM clinical_concept concept JOIN clinical_concept_coding coding ON coding.concept_id=concept.id
              WHERE concept.domain=%s AND coding.system_key=%s AND coding.code=%s ORDER BY concept.is_active DESC LIMIT 1""",(domain,coding_key,coding_code)).fetchone()
        if not concept and code:
            system_key="ICD_10" if version=="ICD-10" else "ICD_9_CM" if version=="ICD-9" else None
            if system_key:
                concept=db.execute("""SELECT concept.* FROM clinical_concept concept JOIN clinical_concept_coding coding ON coding.concept_id=concept.id
                  WHERE concept.domain=%s AND coding.system_key=%s AND coding.code=%s ORDER BY concept.is_active DESC LIMIT 1""",(domain,system_key,code)).fetchone()
        if not concept:
            local_id=text(payload.get("local_id"))
            if local_id: concept=db.execute("SELECT * FROM clinical_concept WHERE domain=%s AND local_id=%s",(domain,local_id)).fetchone()
        if not concept:
            concept=db.execute("SELECT * FROM clinical_concept WHERE domain=%s AND lower(local_name)=lower(%s) ORDER BY is_active DESC LIMIT 1",(domain,name)).fetchone()
        if not concept:
            generated_id=("standard-"+terminology_entry["system_key"].lower().replace("_","-")+"-"+re.sub(r"[^a-z0-9]+","-",terminology_entry["code"].lower()).strip("-"))[:120] if terminology_entry else "local-"+hashlib.sha1((domain+"|"+name.strip().lower()).encode()).hexdigest()[:16]
            concept=db.execute("""INSERT INTO clinical_concept(domain,local_id,local_name,is_active,created_at,updated_at)
              VALUES (%s,%s,%s,1,%s,%s) ON CONFLICT(domain,local_id) DO UPDATE SET local_name=excluded.local_name,updated_at=excluded.updated_at RETURNING *""",
              (domain,generated_id,name,now_ms(),now_ms())).fetchone()
        if terminology_entry and concept:
            db.execute("""INSERT INTO clinical_concept_coding(concept_id,system_key,system_uri,code,display,version,is_preferred,terminology_entry_id,created_at,updated_at)
              VALUES (%s,%s,%s,%s,%s,%s,1,%s,%s,%s)
              ON CONFLICT(concept_id,system_key,code) DO UPDATE SET display=excluded.display,version=excluded.version,
                terminology_entry_id=excluded.terminology_entry_id,is_preferred=1,updated_at=excluded.updated_at""",
              (concept["id"],coding_key,terminology_entry["system_uri"],coding_code,terminology_entry["display"],terminology_entry["version"],terminology_entry["id"],now_ms(),now_ms()))
        snapshot={"local_name":name,"standard_name":label,"icd10_id":code if version=="ICD-10" else None,"icd9cm_id":code if version=="ICD-9" else None}
        if terminology_entry:
            snapshot.update(terminology_entry_id=terminology_entry["id"],terminology_system=terminology_entry["system_key"],terminology_version=terminology_entry["version"])
        if concept:
            snapshot.update(local_id=concept["local_id"])
            codings=db.execute("SELECT system_key,code,display FROM clinical_concept_coding WHERE concept_id=%s AND is_preferred=1",(concept["id"],)).fetchall()
            for coding in codings:
                prefix={"SNOMED_CT":"snomed","ICD_10":"icd10","ICD_9_CM":"icd9cm","LOINC":"loinc","RXNORM":"rxnorm","ATC":"atc","UCUM":"ucum"}[coding["system_key"]]
                snapshot[prefix+"_id"]=coding["code"]
                if coding["display"]: snapshot[prefix+"_name"]=coding["display"]
        snapshot={key:value for key,value in snapshot.items() if value is not None}
        return {required:name,"icd_code":code,"icd_version":version,"icd_text":label,"seq":int(seq or 1),
            "event_ts":event_ts,"entry_context":entry_context,
            "concept_id":concept["id"] if concept else None,"coding_snapshot":Jsonb(snapshot)}

    def create(case_id:int,payload:dict=Body(...),actor:dict=Depends(require_permission("case.chart")),database:Connection=Depends(connection)):
        with database.transaction():
            editable_case(database,case_id)
            data={"case_id":case_id,**values(database,payload),"created_at":now_ms()}
            if path=="allergies": data["source"]="MANUAL"
            row=insert(database,table,data)
            case_audit(database,case_id,path+".insert",None,row,actor)
        return {"ok":True,"id":row["id"],"row":row}

    def edit(case_id:int,entry_id:int,payload:dict=Body(...),actor:dict=Depends(require_permission("case.chart")),database:Connection=Depends(connection)):
        with database.transaction():
            editable_case(database,case_id)
            old=database.execute(sql.SQL("SELECT * FROM {} WHERE id=%s AND case_id=%s").format(sql.Identifier(table)),(entry_id,case_id)).fetchone()
            if not old: raise HTTPException(404,f"{path} not found")
            row=update(database,table,entry_id,values(database,payload,old))
            case_audit(database,case_id,path+".update",old,row,actor)
        return {"ok":True,"row":row}

    def delete(case_id:int,entry_id:int,actor:dict=Depends(require_permission("case.chart")),database:Connection=Depends(connection)):
        with database.transaction():
            editable_case(database,case_id)
            old=database.execute(sql.SQL("DELETE FROM {} WHERE id=%s AND case_id=%s RETURNING *").format(sql.Identifier(table)),(entry_id,case_id)).fetchone()
            if not old: raise HTTPException(404,f"{path} not found")
            case_audit(database,case_id,path+".delete",old,None,actor)
        return {"ok":True}

    router.add_api_route("/{case_id}/"+path,create,methods=["POST"],name=path+"_create")
    router.add_api_route("/{case_id}/"+path+"/{entry_id}",edit,methods=["PUT"],name=path+"_edit")
    router.add_api_route("/{case_id}/"+path+"/{entry_id}",delete,methods=["DELETE"],name=path+"_delete")


register_context_routes("diagnosis","case_diagnosis","diagnosis_text")
register_context_routes("procedures","case_procedure","procedure_text")
register_context_routes("allergies","case_his_allergy","allergen")

ALIASES={
    "ane":({"start ane","start anes","start anesthesia","start anaesthesia","sa"},{"end ane","end anes","end anesthesia","end anaesthesia","ea"}),
    "surg":({"start surg","start surgery","ss"},{"end surg","end surgery","es"}),
}


def lifecycle(title):
    title=" ".join(title.lower().split())
    for scope,(starts,ends) in ALIASES.items():
        if title in starts: return scope,"start"
        if title in ends: return scope,"end"
    return None


def event_audit(db,case_id,old,row,actor,reason=None):
    keys=("event_ts","event_type","title","detail")
    values={"case_id":case_id,"event_note_id":(row or old)["id"],"action":"delete" if row is None else "update" if old else "insert"}
    values.update({"old_"+key:old.get(key) if old else None for key in keys})
    values.update({"new_"+key:row.get(key) if row else None for key in keys})
    values.update(reason=text(reason),actor_username=actor["username"],actor_name=actor.get("name"),actor_role=actor.get("role"),created_at=now_ms())
    insert(db,"case_event_note_audit",values)


def write_event(db,case_id,payload,actor,old=None):
    previous=old or {}
    title=text(payload.get("title",previous.get("title")))
    if not title: raise HTTPException(400,"title required")
    ts=number(payload.get("event_ts",previous.get("event_ts",now_ms())),"event_ts",1)
    if ts is None: raise HTTPException(400,"event_ts required")
    kind="note" if payload.get("event_type",previous.get("event_type"))=="note" else "event"
    parsed=lifecycle(title) if kind=="event" else None
    if parsed:
        scope,phase=parsed
        rows=db.execute("SELECT title,event_ts FROM case_event_note WHERE case_id=%s AND is_deleted=0 AND event_type='event' AND id<>%s ORDER BY event_ts,id",(case_id,previous.get("id",-1))).fetchall()
        starts=0
        opened=0
        for item in rows:
            event=lifecycle(item["title"])
            if not event or event[0]!=scope: continue
            if event[1]=="start": starts+=1
            if item["event_ts"]<=ts: opened=opened+1 if event[1]=="start" else max(0,opened-1)
        label="ANE" if scope=="ane" else "Surgery"
        if phase=="start" and starts: raise HTTPException(400,f"Start {label} already recorded in this case")
        if phase=="end" and opened<=0: raise HTTPException(400,f"Need Start {label} before End {label}")
    values=dict(event_ts=int(ts),event_type=kind,title=title,detail=text(payload.get("detail",previous.get("detail"))),updated_by=actor["username"],updated_at=now_ms())
    if old: row=update(db,"case_event_note",old["id"],values)
    else: row=insert(db,"case_event_note",dict(case_id=case_id,**values,created_by=actor["username"],created_at=now_ms(),is_deleted=0))
    event_audit(db,case_id,old,row,actor,payload.get("reason"))
    return row


@router.post("/{case_id}/events")
def create_event(case_id:int,payload:dict=Body(...),actor:dict=Depends(require_permission("case.chart")),database:Connection=Depends(connection)):
    with database.transaction():
        editable_case(database,case_id)
        row=write_event(database,case_id,payload,actor)
    return {"ok":True,**row}


@router.put("/{case_id}/events/{event_id}")
def edit_event(case_id:int,event_id:int,payload:dict=Body(...),actor:dict=Depends(require_permission("case.chart")),database:Connection=Depends(connection)):
    with database.transaction():
        editable_case(database,case_id)
        old=database.execute("SELECT * FROM case_event_note WHERE id=%s AND case_id=%s AND is_deleted=0",(event_id,case_id)).fetchone()
        if not old: raise HTTPException(404,"event not found")
        write_event(database,case_id,payload,actor,old)
    return {"ok":True,"updated":1}


@router.delete("/{case_id}/events/{event_id}")
def delete_event(case_id:int,event_id:int,payload:dict=Body(default={}),actor:dict=Depends(require_permission("case.chart")),database:Connection=Depends(connection)):
    with database.transaction():
        editable_case(database,case_id)
        old=database.execute("SELECT * FROM case_event_note WHERE id=%s AND case_id=%s AND is_deleted=0",(event_id,case_id)).fetchone()
        if not old: raise HTTPException(404,"event not found")
        update(database,"case_event_note",event_id,{"is_deleted":1,"updated_by":actor["username"],"updated_at":now_ms()})
        event_audit(database,case_id,old,None,actor,payload.get("reason"))
    return {"ok":True,"deleted":1}


@router.put("/{case_id}/timeline")
def timeline(case_id:int,payload:dict=Body(...),actor:dict=Depends(require_permission("case.chart")),database:Connection=Depends(connection)):
    changes=payload.get("changes")
    if not isinstance(changes,list) or not changes: raise HTTPException(400,"changes required")
    counts=dict(inserted=0,updated=0,deleted=0,skipped=0)
    with database.transaction():
        editable_case(database,case_id)
        for item in changes:
            ts=timestamp(item.get("ts_minute"),"ts_minute")
            key=(text(item.get("param_key")) or "").lower()
            if ts is None or not key: raise HTTPException(400,"ts_minute and param_key required")
            old=database.execute("SELECT * FROM case_timeline_value WHERE case_id=%s AND ts_minute=%s AND param_key=%s",(case_id,ts,key)).fetchone()
            delete=item.get("action")=="delete" or item.get("value") in (None,"")
            if delete and not old:
                counts["skipped"]+=1
                continue
            previous=old or {}
            if delete:
                database.execute("DELETE FROM case_timeline_value WHERE id=%s",(old["id"],))
                after=None
                action="delete"
            else:
                value=item["value"]
                numeric=item.get("value_type")=="number" or isinstance(value,(int,float))
                source="override" if item.get("source",previous.get("source"))=="override" else "manual"
                original={
                    "original_value_type":previous.get("original_value_type"),
                    "original_value_num":previous.get("original_value_num"),
                    "original_value_text":previous.get("original_value_text"),
                    "original_source":previous.get("original_source"),
                }
                if source=="override" and not old:
                    minute=database.execute(
                        "SELECT ivy_source,payload FROM vital_minutes WHERE case_id=%s AND ts_minute=%s LIMIT 1",
                        (case_id,ts),
                    ).fetchone()
                    raw_payload=minute.get("payload") if minute else None
                    if isinstance(raw_payload,str):
                        try: raw_payload=json.loads(raw_payload)
                        except json.JSONDecodeError: raw_payload={}
                    raw_value=raw_payload.get(key) if isinstance(raw_payload,dict) else None
                    if raw_value is not None:
                        raw_numeric=isinstance(raw_value,(int,float)) and not isinstance(raw_value,bool)
                        original={
                            "original_value_type":"number" if raw_numeric else "text",
                            "original_value_num":float(raw_value) if raw_numeric else None,
                            "original_value_text":None if raw_numeric else text(raw_value),
                            "original_source":minute.get("ivy_source") if minute else None,
                        }
                data=dict(value_type="number" if numeric else item.get("value_type") if item.get("value_type") in ("text","code") else "code" if key=="ecg" else "text",
                    value_num=number(value,key) if numeric else None,value_text=None if numeric else text(value),
                    unit=text(item.get("unit")) or previous.get("unit"),note=text(item.get("note",previous.get("note"))),
                    source=source,**original)
                if old and all(old[k]==v for k,v in data.items()):
                    counts["skipped"]+=1
                    continue
                data.update(updated_by=actor["username"],updated_at=now_ms())
                after=update(database,"case_timeline_value",old["id"],data) if old else insert(database,"case_timeline_value",dict(case_id=case_id,ts_minute=ts,param_key=key,**data,created_by=actor["username"],created_at=now_ms()))
                action="update" if old else "insert"
            audit=dict(case_id=case_id,ts_minute=ts,param_key=key,action=action)
            for field in ("value_num","value_text","value_type"):
                audit["old_"+field]=previous.get(field)
                audit["new_"+field]=after.get(field) if after else None
            audit.update({k:(after or old).get(k) for k in ("unit","source","note")})
            audit.update({k:(after or old).get(k) for k in ("original_value_type","original_value_num","original_value_text","original_source")})
            audit.update(reason=text(payload.get("reason")),actor_username=actor["username"],actor_name=actor.get("name"),actor_role=actor.get("role"),created_at=now_ms())
            insert(database,"case_timeline_audit",audit)
            counts[{"insert":"inserted","update":"updated","delete":"deleted"}[action]]+=1
    return {"ok":True,**counts}
