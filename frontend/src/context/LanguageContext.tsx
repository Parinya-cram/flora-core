import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  getPreferenceOptions,
  getLanguageTranslations,
  mergeStoredAuthUser,
  updateOwnPreferences,
  type LanguageOption,
} from "../api/authApi";

type LanguageContextValue = {
  language: string;
  languages: LanguageOption[];
  setLanguage: (language: string, fromLogin?: boolean) => void;
  t: (key: string) => string;
};

const FALLBACK_LANGUAGES: LanguageOption[] = [
  { code: "en", nameEn: "English", nameNative: "English" },
  { code: "th", nameEn: "Thai", nameNative: "ไทย" },
];

export const messages: Record<string, Record<string, string>> = {
  en: {
    "login.title": "Sign in",
    "login.username": "Username",
    "login.password": "Password",
    "login.show": "Show",
    "login.hide": "Hide",
    "login.submit": "Sign in",
    "login.submitting": "Signing in…",
    "login.waiting": "Waiting for Flora…",
    "login.failed": "Sign-in failed. Check your username and password.",
    "login.failedRetry": "Sign-in failed. Please try again.",
    "status.title": "Status",
    "status.ready": "Ready",
    "status.checking": "Checking",
    "status.notConnected": "Not connected",
    "status.unavailable": "Unavailable",
    "status.localData": "Local data",
    "status.serverData": "Server data",
    "language.choose": "Language",
    "language.switchTo": "Switch language to",
    "product.leaf.name": "Flora Leaf",
    "product.leaf.description": "Perioperative workstation",
    "product.canopy.name": "Flora Canopy",
    "product.canopy.description": "Central clinical viewer",
    "landing.ready": "Ready to start",
    "admit.patientAdmission": "Patient admission",
    "admit.admissionPath": "Admission path",
    "landing.careUnit": "Care unit",
    "landing.roomBed": "Room · bed",
    "admit.birthdate": "Birthdate",
    "admit.age": "Age",
    "admit.yearsShort": "years",
    "admit.monthsShort": "months",
    "admit.estimatedDob": "Estimated DOB",
    "admit.estimated": "estimated",
    "landing.title": "Prepare a case",
    "landing.subtitle": "Identify the patient, review essential clinical information, and confirm the plan before starting the live record.",
    "landing.caseHistory": "Archive",
    "landing.findPatient": "Who is the patient?",
    "landing.findPatientHelp": "Scan the wristband or enter the hospital number to retrieve the patient from HIS.",
    "landing.hn": "Hospital number (HN)",
    "landing.hnPlaceholder": "Scan or enter HN",
    "landing.search": "Find patient",
    "landing.searching": "Searching…",
    "landing.scan": "Scan",
    "landing.scanHelp": "Use the patient wristband whenever available.",
    "landing.verify": "Verify",
    "landing.verifyHelp": "Confirm two patient identifiers and allergies.",
    "landing.prepare": "Prepare",
    "landing.prepareHelp": "Review operation, diagnosis, team and start time.",
    "landing.preparedPatients": "Prepared patients",
    "landing.preparedPatientsHelp": "Recently retrieved patients available on this Leaf.",
    "landing.noPreparedPatients": "No prepared patients yet.",
    "landing.allergies": "allergies",
    "landing.patientNotFound": "Patient information was not found.",
    "landing.patientLookupFailed": "Patient lookup failed.",
    "landing.manualPatient": "Continue as an emergency/manual patient",
    "landing.manualPatientName": "Manual patient",
    "landing.patientConfirmed": "Patient selected",
    "landing.change": "Change",
    "landing.hisSource": "HIS",
    "landing.bufferSource": "Local buffer",
    "landing.sex": "Sex",
    "landing.dob": "DOB / age",
    "landing.bloodGroup": "Blood group",
    "landing.labs": "Available labs",
    "landing.allergyReview": "Allergy safety check",
    "landing.noAllergyRecord": "No allergy record was returned. Confirm NKA only after checking with the patient or clinical record.",
    "landing.confirmNka": "No known allergies (NKA) confirmed",
    "landing.confirmAllergyReviewed": "I reviewed the recorded allergies",
    "landing.plannedCare": "What care is planned?",
    "landing.plannedCareHelp": "Confirm the operation and diagnosis before activating the clinical record.",
    "landing.operationRequired": "Operation / procedure *",
    "landing.diagnosis": "Diagnosis / indication",
    "landing.startSummary": "Ready to start",
    "landing.location": "Location",
    "landing.thisWorkstation": "This Leaf workstation",
    "landing.responsibleClinician": "Responsible clinician",
    "landing.notAssigned": "Not assigned",
    "landing.startTime": "Case start date & time",
    "landing.identityChecked": "Patient identity available",
    "landing.allergyChecked": "Allergy status reviewed",
    "landing.operationChecked": "Operation confirmed",
    "landing.startCase": "Start clinical record",
    "landing.starting": "Starting case…",
    "landing.startFailed": "The case could not be started.",
    "landing.startNote": "The chart, timeline and device capture open only after the case starts.",
    "landing.overlapWarning": "Device data overlaps the previous case. Choose how Flora should handle it.",
    "landing.startAfterPrevious": "Start after previous data",
    "landing.includeOverlap": "Include overlapping data",
    "topbar.readyNextCase": "Ready",
    "landing.demoExchangePatients": "Demo exchange patients",
    "landing.synthetic": "Synthetic",
    "landing.showCode": "Code",
    "landing.exchangeMessage": "Exchange message",
    "landing.copy": "Copy",
    "landing.encounter": "Encounter",
    "landing.encounterClass": "Class",
    "landing.service": "Service",
    "landing.priority": "Priority",
    "landing.encounterLocation": "Location",
    "landing.attending": "Attending",
    "landing.anaesthesiaTechnique": "Anaesthesia",
    "landing.asaStatus": "ASA status",
    "landing.surgicalPriority": "Surgical priority",
    "landing.priority.elective": "Elective",
    "landing.priority.urgent": "Urgent",
    "landing.priority.emergency": "Emergency",
    "topbar.startCase": "Start case",
    "topbar.config": "Config",
    "topbar.archive": "Archive",
    "topbar.clinicalUser": "Clinical user",
    "topbar.accountSettings": "Account settings",
    "topbar.signOut": "Sign out",
    "system.menu": "System",
    "system.ward": "Ward",
    "system.settings": "System settings",
    "system.workstation": "Workstation",
    "topbar.identityPending": "Identity pending",
    "ward.label": "Ward",
    "ward.all": "All wards",
    "ward.choose": "Choose ward",
    "ward.none": "No ward assigned",
    "login.ldapEnabled": "Directory (LDAP) sign-in enabled",
    "admit.choosePath": "How is this patient being admitted?",
    "admit.choosePathHelp": "Choose the source that matches the real clinical workflow.",
    "admit.prepared": "Prepared case",
    "admit.preparedHelp": "Pre-op, scheduled or previously prepared",
    "admit.preparedIntro": "Select a patient already prepared from pre-op, scheduling or the local admission buffer.",
    "admit.his": "Find in HIS",
    "admit.hisHelp": "Scan or search the hospital record",
    "admit.manual": "Manual admission",
    "admit.manualHelp": "Register locally when HIS is unavailable",
    "admit.emergency": "Emergency",
    "admit.emergencyHelp": "Open the clinical record immediately",
    "admit.tryHis": "Use Find in HIS or register the patient manually.",
    "admit.manualTitle": "Register patient manually",
    "admit.manualIntro": "Use only when the patient cannot be retrieved from HIS. Flora will mark the identity as locally entered.",
    "admit.patientNameRequired": "Patient name *",
    "admit.optional": "optional",
    "admit.unknown": "Unknown",
    "admit.female": "Female",
    "admit.male": "Male",
    "admit.other": "Other",
    "admit.weightKg": "Weight (kg)",
    "admit.continuePreparation": "Continue to safety review",
    "admit.manualIdentityRequired": "Enter a patient name or hospital number.",
    "admit.emergencyTitle": "Start an unidentified emergency case",
    "admit.emergencyIntro": "No patient information is required now. Flora generates a temporary emergency identity and keeps identity, demographics and allergies visibly unresolved until reconciliation.",
    "admit.temporaryIdentity": "Temporary emergency identity will be generated",
    "admit.allergyUnknown": "Allergy and demographics remain unknown",
    "admit.startEmergency": "Start emergency record",
    "admit.localIdOnStart": "Local ID assigned when started",
    "landing.canopyBadge": "Canopy",
    "landing.preopFilled": "Pre-op filled",
    "landing.canopySource": "Canopy admission",
  },
  th: {
    "login.title": "เข้าสู่ระบบ",
    "login.username": "ชื่อผู้ใช้",
    "login.password": "รหัสผ่าน",
    "login.show": "แสดง",
    "login.hide": "ซ่อน",
    "login.submit": "เข้าสู่ระบบ",
    "login.submitting": "กำลังเข้าสู่ระบบ…",
    "login.waiting": "กำลังรอระบบ Flora…",
    "login.failed": "เข้าสู่ระบบไม่สำเร็จ กรุณาตรวจสอบชื่อผู้ใช้และรหัสผ่าน",
    "login.failedRetry": "เข้าสู่ระบบไม่สำเร็จ กรุณาลองอีกครั้ง",
    "status.title": "สถานะระบบ",
    "status.ready": "พร้อมใช้งาน",
    "status.checking": "กำลังตรวจสอบ",
    "status.notConnected": "ยังไม่เชื่อมต่อ",
    "status.unavailable": "ไม่พร้อมใช้งาน",
    "status.localData": "ข้อมูลภายใน",
    "status.serverData": "ข้อมูลส่วนกลาง",
    "language.choose": "ภาษา",
    "language.switchTo": "เปลี่ยนภาษาเป็น",
    "product.leaf.name": "ฟลอร่า ลีฟ",
    "product.leaf.description": "ระบบจัดการงานผ่าตัดและวิสัญญี",
    "product.canopy.name": "ฟลอร่า คาโนปี",
    "product.canopy.description": "ระบบติดตามข้อมูลทางคลินิกส่วนกลาง",
    "landing.ready": "พร้อมเริ่มเคส",
    "admit.patientAdmission": "รับผู้ป่วยเข้าระบบ",
    "admit.admissionPath": "ช่องทางรับผู้ป่วย",
    "landing.careUnit": "หน่วยดูแล",
    "landing.roomBed": "ห้อง · เตียง",
    "admit.birthdate": "วันเกิด",
    "admit.age": "อายุ",
    "admit.yearsShort": "ปี",
    "admit.monthsShort": "เดือน",
    "admit.estimatedDob": "วันเกิดโดยประมาณ",
    "admit.estimated": "ประมาณ",
    "landing.title": "เตรียมเคส",
    "landing.subtitle": "ระบุตัวผู้ป่วย ตรวจสอบข้อมูลสำคัญ และยืนยันแผนการรักษาก่อนเริ่มบันทึกเคส",
    "landing.caseHistory": "คลังเคส",
    "landing.findPatient": "ผู้ป่วยคือใคร?",
    "landing.findPatientHelp": "สแกนสายรัดข้อมือหรือกรอก HN เพื่อค้นหาข้อมูลผู้ป่วยจาก HIS",
    "landing.hn": "เลขประจำตัวผู้ป่วย (HN)",
    "landing.hnPlaceholder": "สแกนหรือกรอก HN",
    "landing.search": "ค้นหาผู้ป่วย",
    "landing.searching": "กำลังค้นหา…",
    "landing.scan": "สแกน",
    "landing.scanHelp": "ใช้สายรัดข้อมือผู้ป่วยเมื่อสามารถทำได้",
    "landing.verify": "ตรวจสอบ",
    "landing.verifyHelp": "ยืนยันตัวตนอย่างน้อยสองรายการและประวัติแพ้",
    "landing.prepare": "เตรียมเคส",
    "landing.prepareHelp": "ตรวจสอบหัตถการ การวินิจฉัย ทีม และเวลาเริ่ม",
    "landing.preparedPatients": "ผู้ป่วยที่เตรียมไว้",
    "landing.preparedPatientsHelp": "ผู้ป่วยที่เรียกข้อมูลล่าสุดบน Leaf เครื่องนี้",
    "landing.noPreparedPatients": "ยังไม่มีผู้ป่วยที่เตรียมไว้",
    "landing.allergies": "รายการแพ้",
    "landing.patientNotFound": "ไม่พบข้อมูลผู้ป่วย",
    "landing.patientLookupFailed": "ค้นหาผู้ป่วยไม่สำเร็จ",
    "landing.manualPatient": "ดำเนินการแบบผู้ป่วยฉุกเฉิน/กรอกเอง",
    "landing.manualPatientName": "ผู้ป่วยกรอกเอง",
    "landing.patientConfirmed": "เลือกผู้ป่วยแล้ว",
    "landing.change": "เปลี่ยน",
    "landing.hisSource": "HIS",
    "landing.bufferSource": "ข้อมูลสำรองในเครื่อง",
    "landing.sex": "เพศ",
    "landing.dob": "วันเกิด / อายุ",
    "landing.bloodGroup": "หมู่เลือด",
    "landing.labs": "ผลตรวจที่มี",
    "landing.allergyReview": "ตรวจสอบความปลอดภัยด้านการแพ้",
    "landing.noAllergyRecord": "ไม่พบข้อมูลการแพ้ โปรดยืนยัน NKA หลังตรวจสอบกับผู้ป่วยหรือเวชระเบียนแล้วเท่านั้น",
    "landing.confirmNka": "ยืนยันไม่มีประวัติแพ้ (NKA)",
    "landing.confirmAllergyReviewed": "ตรวจสอบรายการแพ้แล้ว",
    "landing.plannedCare": "วางแผนทำหัตถการอะไร?",
    "landing.plannedCareHelp": "ยืนยันหัตถการและการวินิจฉัยก่อนเริ่มบันทึกเคส",
    "landing.operationRequired": "การผ่าตัด / หัตถการ *",
    "landing.diagnosis": "การวินิจฉัย / ข้อบ่งชี้",
    "landing.startSummary": "พร้อมเริ่มเคส",
    "landing.location": "สถานที่",
    "landing.thisWorkstation": "เวิร์กสเตชัน Leaf เครื่องนี้",
    "landing.responsibleClinician": "ผู้รับผิดชอบ",
    "landing.notAssigned": "ยังไม่ระบุ",
    "landing.startTime": "วันและเวลาเริ่มเคส",
    "landing.identityChecked": "มีข้อมูลยืนยันตัวผู้ป่วย",
    "landing.allergyChecked": "ตรวจสอบสถานะการแพ้แล้ว",
    "landing.operationChecked": "ยืนยันหัตถการแล้ว",
    "landing.startCase": "เริ่มบันทึกเคส",
    "landing.starting": "กำลังเริ่มเคส…",
    "landing.startFailed": "ไม่สามารถเริ่มเคสได้",
    "landing.startNote": "กราฟ ไทม์ไลน์ และการรับข้อมูลจากอุปกรณ์จะเปิดหลังเริ่มเคสเท่านั้น",
    "landing.overlapWarning": "ข้อมูลจากอุปกรณ์ซ้อนกับเคสก่อนหน้า โปรดเลือกวิธีจัดการ",
    "landing.startAfterPrevious": "เริ่มหลังข้อมูลเคสก่อนหน้า",
    "landing.includeOverlap": "รวมข้อมูลช่วงที่ซ้อนกัน",
    "topbar.readyNextCase": "พร้อม",
    "landing.demoExchangePatients": "ผู้ป่วยจำลองจากระบบแลกเปลี่ยนข้อมูล",
    "landing.synthetic": "ข้อมูลจำลอง",
    "landing.showCode": "ดูโค้ด",
    "landing.exchangeMessage": "ข้อความแลกเปลี่ยนข้อมูล",
    "landing.copy": "คัดลอก",
    "landing.encounter": "ข้อมูลการรับบริการ",
    "landing.encounterClass": "ประเภท",
    "landing.service": "หน่วยบริการ",
    "landing.priority": "ความเร่งด่วน",
    "landing.encounterLocation": "สถานที่",
    "landing.attending": "แพทย์ผู้ดูแล",
    "landing.anaesthesiaTechnique": "วิธีระงับความรู้สึก",
    "landing.asaStatus": "ASA status",
    "landing.surgicalPriority": "ความเร่งด่วนของการผ่าตัด",
    "landing.priority.elective": "ไม่เร่งด่วน",
    "landing.priority.urgent": "เร่งด่วน",
    "landing.priority.emergency": "ฉุกเฉิน",
    "topbar.startCase": "เริ่มเคส",
    "topbar.config": "ตั้งค่า",
    "topbar.archive": "คลังเคส",
    "topbar.clinicalUser": "ผู้ใช้งานทางคลินิก",
    "topbar.accountSettings": "ตั้งค่าบัญชี",
    "topbar.signOut": "ออกจากระบบ",
    "system.menu": "ระบบ",
    "system.ward": "หอผู้ป่วย",
    "system.settings": "ตั้งค่าระบบ",
    "system.workstation": "เครื่องปฏิบัติงาน",
    "topbar.identityPending": "รอยืนยันตัวตน",
    "ward.label": "หอผู้ป่วย",
    "ward.all": "ทุกหอผู้ป่วย",
    "ward.choose": "เลือกหอผู้ป่วย",
    "ward.none": "ยังไม่ได้กำหนดหอผู้ป่วย",
    "login.ldapEnabled": "เปิดใช้การเข้าสู่ระบบด้วยบัญชีองค์กร (LDAP)",
    "admit.choosePath": "รับผู้ป่วยเข้าเคสด้วยวิธีใด?",
    "admit.choosePathHelp": "เลือกแหล่งข้อมูลให้ตรงกับขั้นตอนการทำงานจริง",
    "admit.prepared": "เคสที่เตรียมไว้",
    "admit.preparedHelp": "จาก Pre-op ตารางผ่าตัด หรือที่เตรียมไว้ก่อนหน้า",
    "admit.preparedIntro": "เลือกผู้ป่วยที่เตรียมจาก Pre-op ตารางผ่าตัด หรือข้อมูลรับผู้ป่วยในเครื่อง",
    "admit.his": "ค้นหาจาก HIS",
    "admit.hisHelp": "สแกนหรือค้นหาจากเวชระเบียนโรงพยาบาล",
    "admit.manual": "รับผู้ป่วยด้วยตนเอง",
    "admit.manualHelp": "ลงทะเบียนในเครื่องเมื่อ HIS ใช้งานไม่ได้",
    "admit.emergency": "ฉุกเฉิน",
    "admit.emergencyHelp": "เปิดบันทึกทางคลินิกทันที",
    "admit.tryHis": "ค้นหาจาก HIS หรือลงทะเบียนผู้ป่วยด้วยตนเอง",
    "admit.manualTitle": "ลงทะเบียนผู้ป่วยด้วยตนเอง",
    "admit.manualIntro": "ใช้เมื่อไม่สามารถเรียกข้อมูลจาก HIS ได้ Flora จะระบุว่าข้อมูลตัวตนถูกกรอกในเครื่อง",
    "admit.patientNameRequired": "ชื่อผู้ป่วย *",
    "admit.optional": "ไม่บังคับ",
    "admit.unknown": "ไม่ทราบ",
    "admit.female": "หญิง",
    "admit.male": "ชาย",
    "admit.other": "อื่น ๆ",
    "admit.weightKg": "น้ำหนัก (กก.)",
    "admit.continuePreparation": "ไปตรวจสอบความปลอดภัย",
    "admit.manualIdentityRequired": "กรุณากรอกชื่อผู้ป่วยหรือ HN",
    "admit.emergencyTitle": "เริ่มเคสฉุกเฉินที่ยังไม่ทราบตัวตน",
    "admit.emergencyIntro": "ยังไม่ต้องกรอกข้อมูลผู้ป่วย Flora จะสร้างรหัสฉุกเฉินชั่วคราว และแสดงว่าตัวตน ข้อมูลประชากร และการแพ้ยังไม่ทราบจนกว่าจะยืนยันภายหลัง",
    "admit.temporaryIdentity": "ระบบจะสร้างรหัสฉุกเฉินชั่วคราว",
    "admit.allergyUnknown": "การแพ้และข้อมูลประชากรยังไม่ทราบ",
    "admit.startEmergency": "เริ่มบันทึกฉุกเฉิน",
    "admit.localIdOnStart": "ระบบจะสร้างรหัสในเครื่องเมื่อเริ่มเคส",
    "landing.canopyBadge": "Canopy",
    "landing.preopFilled": "กรอก Pre-op แล้ว",
    "landing.canopySource": "รับผู้ป่วยจาก Canopy",
  },
};

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

function storedUser() {
  try {
    const raw = window.localStorage.getItem("flora_user");
    return raw ? JSON.parse(raw) as { username?: string; languageCode?: string } : {};
  } catch {
    return {};
  }
}

function loginLanguage() {
  return window.localStorage.getItem("flora.loginLanguage") || "en";
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const initialUser = storedUser();
  const [language, setLanguageState] = useState(initialUser.languageCode || loginLanguage());
  const [languages, setLanguages] = useState<LanguageOption[]>(FALLBACK_LANGUAGES);
  const [translationOverrides, setTranslationOverrides] = useState<Record<string, string>>({});
  const lastSyncedRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    void getPreferenceOptions().then(options => {
      if (cancelled || !options.languages.length) return;
      setLanguages(options.languages);
      setLanguageState(current => options.languages.some(item => item.code === current) ? current : options.defaultLanguage);
    }).catch(() => {
      // The built-in English and Thai options keep sign-in available offline.
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const syncAuthLanguage = () => {
      const user = storedUser();
      if (!user.username) {
        setLanguageState(loginLanguage());
        return;
      }
      const selectedAtLogin = window.sessionStorage.getItem("flora.loginLanguage");
      if (selectedAtLogin) window.sessionStorage.removeItem("flora.loginLanguage");
      setLanguageState(selectedAtLogin || user.languageCode || "en");
    };
    window.addEventListener("storage", syncAuthLanguage);
    window.addEventListener("flora:auth-changed", syncAuthLanguage as EventListener);
    return () => {
      window.removeEventListener("storage", syncAuthLanguage);
      window.removeEventListener("flora:auth-changed", syncAuthLanguage as EventListener);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    let cancelled = false;
    void getLanguageTranslations(language).then(values => {
      if (!cancelled) setTranslationOverrides(values);
    }).catch(() => {
      if (!cancelled) setTranslationOverrides({});
    });
    const user = storedUser();
    if (!user.username) return () => { cancelled = true; };
    const syncKey = `${user.username}|${language}`;
    if (lastSyncedRef.current === syncKey) return;
    lastSyncedRef.current = syncKey;
    void updateOwnPreferences({ languageCode: language }).then(nextUser => {
      mergeStoredAuthUser(nextUser);
    }).catch(() => {
      // Retain the local choice until the API is available again.
    });
    return () => { cancelled = true; };
  }, [language]);

  const setLanguage = (next: string, fromLogin = false) => {
    if (!languages.some(item => item.code === next)) return;
    if (fromLogin) {
      window.localStorage.setItem("flora.loginLanguage", next);
      window.sessionStorage.setItem("flora.loginLanguage", next);
    }
    setLanguageState(next);
  };

  const t = (key: string) => translationOverrides[key] || messages[language]?.[key] || messages.en[key] || key;

  return (
    <LanguageContext.Provider value={{ language, languages, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used within LanguageProvider");
  return context;
}
