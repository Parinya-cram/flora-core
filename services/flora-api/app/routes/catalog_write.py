import re
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from psycopg import Connection
from psycopg.types.json import Jsonb

from .. import staff_sync
from ..clinical import flag, insert, number, text, update, case_audit
from ..database import connection
from .auth_leaf import now_ms, require_permission
from .cases_lifecycle import editable_case

router = APIRouter(prefix="/api/case", tags=["clinical catalogs"], dependencies=[Depends(require_permission("case.read"))])


@router.get("/icd10/search")
def icd10_search(q: str = "", limit: int = Query(40, ge=1, le=200), database: Connection = Depends(connection)):
    query = q.strip()
    if not query:
        return {"query": "", "rows": []}
    compact = re.sub(r"\s+", "", query.upper())
    pattern = f"%{query}%"
    rows = database.execute(
        """SELECT icd10,icd10who,name_en,name_th,
          CASE WHEN icd10=%s OR icd10who=%s THEN 1000
               WHEN icd10 ILIKE %s OR icd10who ILIKE %s THEN 900
               WHEN coalesce(name_en,'') ILIKE %s OR coalesce(name_th,'') ILIKE %s THEN 700 ELSE 0 END AS score
          FROM icd10_master
          WHERE icd10 ILIKE %s OR icd10who ILIKE %s OR coalesce(name_en,'') ILIKE %s OR coalesce(name_th,'') ILIKE %s
          ORDER BY score DESC,icd10 LIMIT %s""",
        (compact, compact, compact+"%", compact+"%", pattern, pattern,
         compact+"%", compact+"%", pattern, pattern, limit),
    ).fetchall()
    return {"query": query, "rows": rows}


@router.get("/icd9/search")
def icd9_search(q: str = "", limit: int = Query(20, ge=1, le=50), database: Connection = Depends(connection)):
    query = q.strip()
    if not query:
        return {"query": query, "rows": []}
    code = re.sub(r"[\s.]", "", query)
    like = f"%{query}%"
    rows = database.execute(
        """SELECT icd9cm,short_name_en,name_en,
          CASE WHEN icd9cm=%s THEN 1000 WHEN icd9cm LIKE %s THEN 920
               WHEN coalesce(name_en,'') ILIKE %s THEN 820 ELSE 0 END AS score
          FROM icd9cm_master WHERE icd9cm LIKE %s OR coalesce(name_en,'') ILIKE %s OR coalesce(short_name_en,'') ILIKE %s
          ORDER BY score DESC,icd9cm LIMIT %s""",
        (code,code+"%",like,code+"%",like,like,limit),
    ).fetchall()
    return {"query": query, "rows": rows}


def role(db: Connection, role_id, label=None):
    role_id=text(role_id)
    row=db.execute("SELECT id,display_name FROM staff_role WHERE id=%s",(role_id,)).fetchone() if role_id else None
    if not row and label:
        row=db.execute("SELECT id,display_name FROM staff_role WHERE lower(display_name)=lower(%s)",(text(label),)).fetchone()
    if not row:
        raise HTTPException(400,"valid staff role required")
    return row["id"],row["display_name"]


STAFF_FIELD_TYPES={"text","email","number","date","select"}
STAFF_NAME_PARTS={"prefix","given","middle","family","suffix"}
STAFF_CORE_MAPPINGS={"hospital_id","staff_name","email","personal_id","entry_year","innovian_id"}


def staff_field_values(payload,old=None):
    old=old or {}
    key=text(payload.get("field_key",old.get("field_key")))
    if not key or not re.fullmatch(r"[a-z][a-z0-9_]{1,63}",key):
        raise HTTPException(400,"field_key must use lowercase letters, numbers, and underscores")
    label=text(payload.get("label",old.get("label")))
    if not label: raise HTTPException(400,"label required")
    field_type=text(payload.get("field_type",old.get("field_type","text"))) or "text"
    if field_type not in STAFF_FIELD_TYPES: raise HTTPException(400,"invalid field type")
    name_part=text(payload.get("name_part",old.get("name_part")))
    if name_part and name_part not in STAFF_NAME_PARTS: raise HTTPException(400,"invalid name part")
    core_mapping=text(payload.get("core_mapping",old.get("core_mapping")))
    if core_mapping and core_mapping not in STAFF_CORE_MAPPINGS: raise HTTPException(400,"invalid core mapping")
    options=payload.get("options",payload.get("options_json",old.get("options_json",[])))
    if not isinstance(options,list): raise HTTPException(400,"options must be a list")
    options=[str(item).strip() for item in options if str(item).strip()]
    return dict(field_key=key,label=label,field_type=field_type,
        language_code=text(payload.get("language_code",old.get("language_code"))),
        name_part=name_part,core_mapping=core_mapping,options_json=Jsonb(options),
        is_required=flag(payload.get("is_required",old.get("is_required",0)),False),
        is_active=flag(payload.get("is_active",old.get("is_active",1))),
        sort_order=int(number(payload.get("sort_order",old.get("sort_order",100)),"sort_order",0) or 0),
        updated_at=now_ms())


@router.get("/staff/fields")
def staff_fields(include_inactive:bool=False,database:Connection=Depends(connection)):
    rows=database.execute("""SELECT id,field_key,label,field_type,language_code,name_part,core_mapping,
      options_json AS options,is_required,is_active,sort_order,created_at,updated_at
      FROM staff_field_master WHERE (%s OR is_active=1) ORDER BY sort_order,id""",(include_inactive,)).fetchall()
    return {"rows":rows}


@router.post("/staff/fields")
def create_staff_field(payload:dict=Body(...),_:dict=Depends(require_permission("staff.manage")),database:Connection=Depends(connection)):
    values=staff_field_values(payload); values["created_at"]=now_ms()
    if database.execute("SELECT 1 FROM staff_field_master WHERE field_key=%s",(values["field_key"],)).fetchone():
        raise HTTPException(409,"field key already exists")
    return {"ok":True,"row":insert(database,"staff_field_master",values)}


@router.put("/staff/fields/{field_id}")
def edit_staff_field(field_id:int,payload:dict=Body(...),_:dict=Depends(require_permission("staff.manage")),database:Connection=Depends(connection)):
    old=database.execute("SELECT * FROM staff_field_master WHERE id=%s",(field_id,)).fetchone()
    if not old: raise HTTPException(404,"staff field not found")
    values=staff_field_values(payload,old)
    duplicate=database.execute("SELECT 1 FROM staff_field_master WHERE field_key=%s AND id<>%s",(values["field_key"],field_id)).fetchone()
    if duplicate: raise HTTPException(409,"field key already exists")
    return {"ok":True,"row":update(database,"staff_field_master",field_id,values)}


@router.delete("/staff/fields/{field_id}")
def disable_staff_field(field_id:int,_:dict=Depends(require_permission("staff.manage")),database:Connection=Depends(connection)):
    row=database.execute("UPDATE staff_field_master SET is_active=0,updated_at=%s WHERE id=%s RETURNING id",(now_ms(),field_id)).fetchone()
    if not row: raise HTTPException(404,"staff field not found")
    return {"ok":True,"deactivated":1}


def staff_values(db,payload,old=None):
    source=payload.get("staff") if isinstance(payload.get("staff"),dict) else payload
    old=old or {}
    role_id,role_label=role(db,source.get("role_id",source.get("staff_role_id",old.get("staff_role_id"))),source.get("role",old.get("staff_role")))
    profile=dict(old.get("profile_data") or {}) if isinstance(old.get("profile_data"),dict) else {}
    incoming=source.get("profile_data")
    if isinstance(incoming,dict):
        profile.update({str(k):v for k,v in incoming.items() if isinstance(v,(str,int,float,bool)) or v is None})
    legacy_profile={
        "hospital_id":source.get("hospital_id"),"display_name":source.get("name",source.get("staff_name")),
        "email":source.get("email"),"personal_id":source.get("personal_id"),"entry_year":source.get("entry_year"),
        "name_th_given":source.get("th_first_name"),"name_th_family":source.get("th_last_name"),
        "name_en_given":source.get("en_first_name"),"name_en_family":source.get("en_last_name")}
    for key,value in legacy_profile.items():
        if value is not None: profile[key]=value
    fields=db.execute("SELECT * FROM staff_field_master WHERE is_active=1 ORDER BY sort_order,id").fetchall()
    mapped={row["core_mapping"]:profile.get(row["field_key"]) for row in fields if row.get("core_mapping")}
    for row in fields:
        if row["is_required"] and (profile.get(row["field_key"]) is None or str(profile.get(row["field_key"])).strip()==""):
            raise HTTPException(400,f'{row["label"]} required')
    values={k:text(source.get(k,old.get(k))) for k in ("hospital_id","personal_id","email","th_first_name","th_last_name","en_first_name","en_last_name","innovian_id")}
    for key in ("hospital_id","personal_id","email","innovian_id"):
        if mapped.get(key) is not None: values[key]=text(mapped[key])
    values["th_first_name"]=text(profile.get("name_th_given",values["th_first_name"]))
    values["th_last_name"]=text(profile.get("name_th_family",values["th_last_name"]))
    values["en_first_name"]=text(profile.get("name_en_given",values["en_first_name"]))
    values["en_last_name"]=text(profile.get("name_en_family",values["en_last_name"]))
    values["email"]=(values["email"] or "").lower() or None
    values["staff_role_id"]=role_id
    values["staff_role"]=role_label
    values["staff_code"]=text(source.get("staff_code",old.get("staff_code")))
    name_parts=[text(profile.get(row["field_key"])) for row in fields if row.get("name_part")]
    values["staff_name"]=text(mapped.get("staff_name")) or text(source.get("name",source.get("staff_name",old.get("staff_name")))) or " ".join(filter(None,name_parts)) or " ".join(filter(None,(values["en_first_name"],values["en_last_name"])))
    if not values["staff_name"]:
        raise HTTPException(400,"staff name required")
    profile["display_name"]=values["staff_name"]
    entry=mapped.get("entry_year",source.get("entry_year",old.get("entry_year")))
    # Older clients sent 0 for "no entry year".
    entry=number(None if entry in (0,"0") else entry,"entry_year",1900)
    values["entry_year"]=int(entry) if entry else None
    values["profile_data"]=Jsonb(profile)
    return values


def check_staff_sync_rules(db,values,entry_id=None):
    """Doctors and nurses need a staff code (it is how Canopy recognises them); a code is used once."""
    if not values["staff_code"] and staff_sync.needs_code(db,values["staff_role_id"]):
        raise HTTPException(400,f'staff code required for {values["staff_role"]} (doctor or nurse code)')
    if values["staff_code"]:
        clash=db.execute("SELECT id,staff_name FROM staff_directory WHERE lower(staff_code)=lower(%s) AND id IS DISTINCT FROM %s",
                         (values["staff_code"],entry_id)).fetchone()
        if clash: raise HTTPException(409,f'staff code {values["staff_code"]} is already used by {clash["staff_name"]}')


def mark_for_canopy(values,current):
    """A coded person added or edited here goes up to Canopy on the next sync."""
    values["directory_pending"]=1 if values["staff_code"] else 0
    values["directory_version"]=current
    values["sync_error"]=None


def refuse_managed(row):
    if row and row.get("directory_managed"):
        raise HTTPException(409,"this person is managed by Canopy; change them in Canopy → Staff directory")


@router.get("/staff/directory")
def staff_directory(q:str="",role_id:str="",include_inactive:bool=False,limit:int=Query(200,ge=1,le=500),database:Connection=Depends(connection)):
    like=f"%{q.strip()}%"
    rows=database.execute("""SELECT id,hospital_id,personal_id,email,th_first_name,th_last_name,en_first_name,en_last_name,
      innovian_id,staff_role_id AS role_id,staff_name AS name,staff_role AS role,entry_year,profile_data,is_active,used_count,last_used_at,created_at,updated_at,
      staff_code,directory_managed,directory_pending,sync_error
      FROM staff_directory WHERE (%s OR is_active=1) AND (%s='' OR staff_role_id=%s)
      AND (%s='' OR staff_name ILIKE %s OR coalesce(hospital_id,'') ILIKE %s OR coalesce(staff_code,'') ILIKE %s OR coalesce(email,'') ILIKE %s OR profile_data::text ILIKE %s)
      ORDER BY is_active DESC,last_used_at DESC NULLS LAST,used_count DESC,staff_name LIMIT %s""",
      (include_inactive,role_id,role_id,q.strip(),like,like,like,like,like,limit)).fetchall()
    return {"rows":rows}


@router.get("/staff/library")
def staff_library(limit:int=Query(50,ge=1,le=200),database:Connection=Depends(connection)):
    return {"rows":database.execute("""SELECT hospital_id,personal_id,email,th_first_name,th_last_name,en_first_name,en_last_name,innovian_id,
      staff_role_id AS role_id,staff_name AS name,staff_role AS role,entry_year,profile_data,is_active,used_count,last_used_at,staff_code
      FROM staff_directory WHERE is_active=1 ORDER BY last_used_at DESC NULLS LAST,used_count DESC,staff_name LIMIT %s""",(limit,)).fetchall()}


@router.post("/staff/directory")
def create_staff(payload:dict=Body(...),actor:dict=Depends(require_permission("staff.manage")),database:Connection=Depends(connection)):
    values=staff_values(database,payload)
    with database.transaction():
        existing=None
        if values["staff_code"]:
            existing=database.execute("SELECT * FROM staff_directory WHERE lower(staff_code)=lower(%s)",(values["staff_code"],)).fetchone()
            if existing and (existing["staff_name"]!=values["staff_name"] or existing["staff_role_id"]!=values["staff_role_id"]):
                raise HTTPException(409,f'staff code {values["staff_code"]} is already used by {existing["staff_name"]} ({existing["staff_role"]})')
        if not existing and values["hospital_id"]: existing=database.execute("SELECT * FROM staff_directory WHERE hospital_id=%s",(values["hospital_id"],)).fetchone()
        if not existing and values["email"]: existing=database.execute("SELECT * FROM staff_directory WHERE lower(email)=lower(%s)",(values["email"],)).fetchone()
        if not existing: existing=database.execute("SELECT * FROM staff_directory WHERE staff_name=%s AND staff_role_id=%s",(values["staff_name"],values["staff_role_id"])).fetchone()
        current=now_ms()
        refuse_managed(existing)
        check_staff_sync_rules(database,values,existing["id"] if existing else None)
        mark_for_canopy(values,current)
        values.update(is_active=1,last_used_at=current,updated_at=current)
        row=update(database,"staff_directory",existing["id"],values) if existing else insert(database,"staff_directory",dict(**values,used_count=0,created_at=current))
    return {"ok":True,"row":row}


@router.put("/staff/directory/{entry_id}")
def edit_staff(entry_id:int,payload:dict=Body(...),_:dict=Depends(require_permission("staff.manage")),database:Connection=Depends(connection)):
    old=database.execute("SELECT * FROM staff_directory WHERE id=%s",(entry_id,)).fetchone()
    if not old: raise HTTPException(404,"staff not found")
    refuse_managed(old)
    values=staff_values(database,payload,old)
    check_staff_sync_rules(database,values,entry_id)
    current=now_ms()
    mark_for_canopy(values,current)
    values.update(is_active=flag(payload.get("is_active",old["is_active"])),updated_at=current)
    return {"ok":True,"row":update(database,"staff_directory",entry_id,values)}


@router.delete("/staff/directory/{entry_id}")
def disable_staff(entry_id:int,_:dict=Depends(require_permission("staff.manage")),database:Connection=Depends(connection)):
    refuse_managed(database.execute("SELECT directory_managed FROM staff_directory WHERE id=%s",(entry_id,)).fetchone())
    row=database.execute("UPDATE staff_directory SET is_active=0,updated_at=%s WHERE id=%s RETURNING id",(now_ms(),entry_id)).fetchone()
    if not row: raise HTTPException(404,"staff not found")
    return {"ok":True,"deactivated":1}


@router.get("/staff/my-cases")
def my_cases(hospital_id:str="",personal_id:str="",email:str="",staff_directory_id:int|None=None,database:Connection=Depends(connection)):
    if staff_directory_id is not None:
        linked=database.execute("SELECT hospital_id,personal_id,email,staff_name FROM staff_directory WHERE id=%s",(staff_directory_id,)).fetchone()
        if not linked: raise HTTPException(404,"staff directory entry not found")
        rows=database.execute("""SELECT DISTINCT c.id,c.case_code,c.hn,c.start_time,c.discharge_time,c.status,cs.staff_role,cs.staff_name
          FROM case_staff cs JOIN cases c ON c.id=cs.case_id WHERE
          (nullif(%s,'') IS NOT NULL AND cs.hospital_id=%s) OR
          (nullif(%s,'') IS NOT NULL AND cs.personal_id=%s) OR
          (nullif(%s,'') IS NOT NULL AND lower(cs.email)=lower(%s)) OR
          (cs.staff_name=%s) ORDER BY c.start_time DESC LIMIT 200""",
          (linked["hospital_id"],linked["hospital_id"],linked["personal_id"],linked["personal_id"],linked["email"],linked["email"],linked["staff_name"])).fetchall()
        return {"rows":rows}
    if not any((hospital_id,personal_id,email)): raise HTTPException(400,"at least one identifier or staff_directory_id required")
    rows=database.execute("""SELECT DISTINCT c.id,c.case_code,c.hn,c.start_time,c.discharge_time,c.status,cs.staff_role,cs.staff_name
      FROM case_staff cs JOIN cases c ON c.id=cs.case_id WHERE (%s<>'' AND cs.hospital_id=%s) OR (%s<>'' AND cs.personal_id=%s)
      OR (%s<>'' AND lower(cs.email)=lower(%s)) ORDER BY c.start_time DESC LIMIT 200""",
      (hospital_id,hospital_id,personal_id,personal_id,email,email)).fetchall()
    return {"rows":rows}


def staff_times(item):
    """time_in / time_out of one case staff row (minute precision); out may not be before in."""
    def minute(key):
        value=item.get(key)
        if value in (None,""): return None
        try: return int(value)//60000*60000
        except (TypeError,ValueError): raise HTTPException(400,f"{key} must be a time") from None
    time_in,time_out=minute("time_in"),minute("time_out")
    if time_in is not None and time_out is not None and time_out<time_in:
        raise HTTPException(400,f'{text(item.get("name")) or "staff"}: time out is before time in')
    return dict(time_in=time_in,time_out=time_out)


def has_staff_times(db):
    return db.execute("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='case_staff' AND column_name='time_out'").fetchone() is not None


@router.put("/{case_id}/staff")
def replace_staff(case_id:int,payload:dict=Body(...),actor:dict=Depends(require_permission("case.chart")),database:Connection=Depends(connection)):
    raw=payload.get("staff") if isinstance(payload.get("staff"),list) else []
    if len(raw)>200: raise HTTPException(400,"too many staff rows")
    with database.transaction():
        editable_case(database,case_id)
        times=has_staff_times(database)
        before=database.execute("SELECT * FROM case_staff WHERE case_id=%s ORDER BY seq,id",(case_id,)).fetchall()
        normalized=[]
        seen=set()
        for item in raw:
            values=staff_values(database,item)
            if times: values.update(staff_times(item))
            key=(values["staff_name"].lower(),values["staff_role_id"],(values["hospital_id"] or "").lower())
            if key in seen: continue
            seen.add(key); normalized.append(values)
        database.execute("DELETE FROM case_staff WHERE case_id=%s",(case_id,))
        current=now_ms(); rows=[]
        for index,values in enumerate(normalized,1):
            row=insert(database,"case_staff",dict(case_id=case_id,**values,seq=index,created_by=actor["username"],created_at=current,updated_at=current)); rows.append(row)
            if values["staff_code"]:
                known=database.execute("SELECT id FROM staff_directory WHERE lower(staff_code)=lower(%s)",(values["staff_code"],)).fetchone()
                if known:
                    database.execute("UPDATE staff_directory SET used_count=used_count+1,last_used_at=%s WHERE id=%s",(current,known["id"]))
                    continue
            # A new coded person typed into a case also goes up to Canopy; Canopy-managed entries keep their data.
            database.execute("""INSERT INTO staff_directory(hospital_id,personal_id,email,th_first_name,th_last_name,en_first_name,en_last_name,innovian_id,staff_role_id,staff_name,staff_role,entry_year,profile_data,staff_code,is_active,used_count,last_used_at,created_at,updated_at,directory_pending,directory_version)
              VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1,1,%s,%s,%s,CASE WHEN coalesce(%s,'')<>'' THEN 1 ELSE 0 END,%s)
              ON CONFLICT(staff_name,staff_role) DO UPDATE SET
                profile_data=CASE WHEN staff_directory.directory_managed=1 THEN staff_directory.profile_data ELSE excluded.profile_data END,
                staff_code=CASE WHEN staff_directory.directory_managed=1 OR coalesce(staff_directory.staff_code,'')<>'' THEN staff_directory.staff_code ELSE excluded.staff_code END,
                directory_pending=CASE WHEN staff_directory.directory_managed=0 AND coalesce(staff_directory.staff_code,'')='' AND coalesce(excluded.staff_code,'')<>'' THEN 1 ELSE staff_directory.directory_pending END,
                used_count=staff_directory.used_count+1,last_used_at=excluded.last_used_at,updated_at=excluded.updated_at""",
              tuple(values[k] for k in ("hospital_id","personal_id","email","th_first_name","th_last_name","en_first_name","en_last_name","innovian_id","staff_role_id","staff_name","staff_role","entry_year","profile_data","staff_code"))+(current,current,current,values["staff_code"],current))
        case_audit(database,case_id,"staff.replace",before,rows,actor)
    return {"ok":True,"case_id":case_id,"rows":[dict(id=r["id"],hospital_id=r["hospital_id"],personal_id=r["personal_id"],email=r["email"],th_first_name=r["th_first_name"],th_last_name=r["th_last_name"],en_first_name=r["en_first_name"],en_last_name=r["en_last_name"],innovian_id=r["innovian_id"],role_id=r["staff_role_id"],name=r["staff_name"],role=r["staff_role"],entry_year=r["entry_year"],profile_data=r["profile_data"],seq=r["seq"],staff_code=r.get("staff_code"),time_in=r.get("time_in"),time_out=r.get("time_out")) for r in rows]}


def io_code(value):
    tokens=re.findall(r"[A-Za-z0-9]+",str(value or ""))
    return "" if not tokens else tokens[0].lower()+"".join(token.title() for token in tokens[1:])


@router.get("/io/groups")
def io_groups(kind:str="",include_inactive:bool=False,database:Connection=Depends(connection)):
    normalized=kind if kind in {"med","fluid","output"} else ""
    rows=database.execute("""SELECT * FROM io_group_master
      WHERE (%s='' OR kind=%s) AND (%s OR is_active=1)
      ORDER BY sort_order,display_name,code""",(normalized,normalized,include_inactive)).fetchall()
    return {"rows":rows}


def group_values(payload,old=None):
    old=old or {}; kind=payload.get("kind",old.get("kind","med")); kind=kind if kind in {"med","fluid","output"} else "med"
    name=text(payload.get("display_name",old.get("display_name")))
    if not name: raise HTTPException(400,"group name required")
    code=io_code(payload.get("code",old.get("code")) or name)
    if not code: raise HTTPException(400,"group code required")
    return dict(code=code,display_name=name,kind=kind,is_active=flag(payload.get("is_active",old.get("is_active",1))),sort_order=int(payload.get("sort_order",old.get("sort_order",0)) or 0),updated_at=now_ms())


@router.post("/io/groups")
def create_io_group(payload:dict=Body(...),_:dict=Depends(require_permission("clinical_master.manage")),database:Connection=Depends(connection)):
    values=group_values(payload)
    if database.execute("SELECT 1 FROM io_group_master WHERE lower(code)=lower(%s)",(values["code"],)).fetchone():
        raise HTTPException(409,"group code already exists")
    return {"ok":True,"row":insert(database,"io_group_master",dict(**values,created_at=now_ms()))}


@router.put("/io/groups/{group_id}")
def edit_io_group(group_id:int,payload:dict=Body(...),_:dict=Depends(require_permission("clinical_master.manage")),database:Connection=Depends(connection)):
    old=database.execute("SELECT * FROM io_group_master WHERE id=%s",(group_id,)).fetchone()
    if not old: raise HTTPException(404,"group not found")
    values=group_values(payload,old)
    if database.execute("SELECT 1 FROM io_group_master WHERE lower(code)=lower(%s) AND id<>%s",(values["code"],group_id)).fetchone():
        raise HTTPException(409,"group code already exists")
    with database.transaction():
        row=update(database,"io_group_master",group_id,values)
        database.execute("UPDATE io_item_master SET category=%s,updated_at=%s WHERE group_id=%s",(values["code"],now_ms(),group_id))
    return {"ok":True,"row":row}


@router.delete("/io/groups/{group_id}")
def disable_io_group(group_id:int,_:dict=Depends(require_permission("clinical_master.manage")),database:Connection=Depends(connection)):
    row=database.execute("UPDATE io_group_master SET is_active=0,updated_at=%s WHERE id=%s RETURNING *",(now_ms(),group_id)).fetchone()
    if not row: raise HTTPException(404,"group not found")
    return {"ok":True,"row":row}


@router.get("/io/master")
def io_master(kind:str="med",q:str="",include_inactive:bool=False,limit:int=Query(300,ge=1,le=500),database:Connection=Depends(connection)):
    kind=kind if kind in {"med","fluid","output"} else "med"; like=f"%{q.strip()}%"
    rows=database.execute("""SELECT * FROM io_item_master WHERE kind=%s AND (%s OR is_active=1)
      AND (%s='' OR code ILIKE %s OR name ILIKE %s OR coalesce(category,'') ILIKE %s OR coalesce(default_unit,'') ILIKE %s)
      ORDER BY is_active DESC,usage_rank NULLS LAST,usage_score DESC,name,code LIMIT %s""",(kind,include_inactive,q.strip(),like,like,like,like,limit)).fetchall()
    return {"rows":rows}


def master_values(database:Connection,payload,old=None):
    old=old or {}; kind=payload.get("kind",old.get("kind","med")); kind=kind if kind in {"med","fluid","output"} else "med"
    name=text(payload.get("name",old.get("name")))
    if not name: raise HTTPException(400,"name required")
    code=io_code(payload.get("code",old.get("code")) or name)
    if not code: raise HTTPException(400,"code or valid name required")
    category=text(payload.get("category",old.get("category")))
    raw_group_id=payload.get("group_id",old.get("group_id"))
    group=None
    if raw_group_id not in (None,""):
        group=database.execute("SELECT id,code,kind FROM io_group_master WHERE id=%s",(int(raw_group_id),)).fetchone()
    elif category:
        group=database.execute("SELECT id,code,kind FROM io_group_master WHERE lower(code)=lower(%s)",(category,)).fetchone()
    if group and group["kind"]!=kind: raise HTTPException(400,"group kind does not match item kind")
    if group: category=group["code"]
    return dict(kind=kind,code=code,name=name,default_unit=text(payload.get("default_unit",old.get("default_unit"))) or "ml",category=category,group_id=group["id"] if group else None,is_active=flag(payload.get("is_active",old.get("is_active",1))),updated_at=now_ms())


def ensure_io_concept(database:Connection,values:dict):
    domain="medication" if values["kind"]=="med" else "blood_product" if values["kind"]=="fluid" and str(values.get("category") or "").lower()=="bloodproduct" else values["kind"]
    return database.execute("""INSERT INTO clinical_concept(domain,local_id,local_name,is_active,created_at,updated_at)
      VALUES (%s,%s,%s,%s,%s,%s)
      ON CONFLICT(domain,local_id) DO UPDATE SET local_name=excluded.local_name,is_active=excluded.is_active,updated_at=excluded.updated_at
      RETURNING id""",(domain,values["code"],values["name"],values["is_active"],now_ms(),now_ms())).fetchone()["id"]


@router.post("/io/master")
def create_master(payload:dict=Body(...),_:dict=Depends(require_permission("clinical_master.manage")),database:Connection=Depends(connection)):
    values=master_values(database,payload); base=values["code"]; suffix=2
    while database.execute("SELECT 1 FROM io_item_master WHERE code=%s",(values["code"],)).fetchone(): values["code"]=base+str(suffix); suffix+=1
    with database.transaction():
        values["concept_id"]=ensure_io_concept(database,values)
        row=insert(database,"io_item_master",dict(**values,created_at=now_ms()))
    return {"ok":True,"row":row}


@router.put("/io/master/{item_id}")
def edit_master(item_id:int,payload:dict=Body(...),_:dict=Depends(require_permission("clinical_master.manage")),database:Connection=Depends(connection)):
    old=database.execute("SELECT * FROM io_item_master WHERE id=%s",(item_id,)).fetchone()
    if not old: raise HTTPException(404,"not found")
    values=master_values(database,payload,old); base=values["code"]; suffix=2
    while database.execute("SELECT 1 FROM io_item_master WHERE code=%s AND id<>%s",(values["code"],item_id)).fetchone(): values["code"]=base+str(suffix); suffix+=1
    with database.transaction():
        values["concept_id"]=ensure_io_concept(database,values)
        row=update(database,"io_item_master",item_id,values)
    return {"ok":True,"row":row}


@router.delete("/io/master/{item_id}")
def disable_master(item_id:int,_:dict=Depends(require_permission("clinical_master.manage")),database:Connection=Depends(connection)):
    row=database.execute("UPDATE io_item_master SET is_active=0,updated_at=%s WHERE id=%s RETURNING id",(now_ms(),item_id)).fetchone()
    if not row: raise HTTPException(404,"not found")
    return {"ok":True,"deactivated":1}
