#!/usr/bin/env bash
# Flora Gateway (Ubuntu / Linux): add device types (local templates) for the patient monitors in
# "CIS-LIFE Patient Monitor Database" (medical_device_support.pdf) whose protocol Flora Gateway
# reads with a parser that is in the gateway's parser image (flora-gateway-parser:dev):
#   protocol hl7v2           -> parser hl7v2 (GE models: hidro_hl7, with GE parameter names)
#   protocol draeger-vista-s -> parser draeger_vista_s (Vista CMS link, TCP)
#   protocol ge-s5-dri       -> parser ge_dri (GE S/5 DRI over RS-232)
# Models with no such protocol/parser are not listed.
# Same list and behaviour as windows/add-device-types.bat.
#
#   ./add-device-types.sh                 menu
#   ./add-device-types.sh 1 39 81         these entries (numbers as in the PDF; 81-82 = direct RS-232 route)
#   ./add-device-types.sh ALL             every entry
#   ./add-device-types.sh HL7             HL7 v2 built in        (support = hl7)
#   ./add-device-types.sh OPT             HL7 v2 vendor option   (support = hl7-option)
#   ./add-device-types.sh NATIVE          dedicated Flora parser (support = native)
#
# Targets: 1 Flora Root - add the picked models' type codes to a tenant's license (default)
#          2 Flora Gateway - create the device types (parser, connection settings)
#          3 both
# Options (environment): TARGET=1|2|3, MODE=1 send | 2 dry run (both asked when unset),
#   FLORA_ROOT_URL (https://172.22.19.81:8443), FLORA_ROOT_TENANT (kcmh), FLORA_ROOT_USER (admin),
#   FLORA_ROOT_PASSWORD, FLORA_ROOT_CACERT (Root CA file; without it Root's certificate is not verified),
#   FLORA_GW_URL (http://172.22.1.233:7400), FLORA_GW_USER (admin), FLORA_GW_PASSWORD.
# Needs curl and python3. A protocol match is not a model validation. A device of a type can be
# enabled only when the type exists on the gateway (or comes from Canopy) AND its code is licensed.
set -uo pipefail

GW=${FLORA_GW_URL:-http://172.22.1.233:7400}
GWUSER=${FLORA_GW_USER:-admin}
GWPASS=${FLORA_GW_PASSWORD:-}
ROOT=${FLORA_ROOT_URL:-https://172.22.19.81:8443}
ROOT_TENANT=${FLORA_ROOT_TENANT:-kcmh}
ROOTUSER=${FLORA_ROOT_USER:-admin}
ROOTPASS=${FLORA_ROOT_PASSWORD:-}
TARGET=${TARGET:-}
MODE=${MODE:-}
command -v curl >/dev/null || { echo "curl not found: sudo apt install curl"; exit 1; }
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# ------------------------------------------------------------------ data
# MFR|code|name|country
# DEV|no|code|manufacturer|model|label|support|category|protocol|controller|parser|connection_defaults|default_options
# support: hl7 = HL7 v2.x built in (PDF "Yes"); hl7-option = PDF "Optional" (vendor HL7 option needed);
# native = dedicated Flora parser (Vista CMS link, GE S/5 DRI over RS-232).
# Not listed (no protocol Flora reads: no HL7 and no Flora parser): #50 Biolight A3/A2E,
# #59 Welch Allyn Connex ProBP 3400, #73 Contec CMS 6000/5100.
DATA=$(cat <<'EOF'
MFR|philips|Philips|Netherlands
MFR|ge|GE Healthcare|USA
MFR|mindray|Mindray|China
MFR|nihon-kohden|Nihon Kohden|Japan
MFR|draeger|Draegerwerk AG|Germany
MFR|spacelabs|Spacelabs|USA
MFR|edan|Edan|China
MFR|biolight|Biolight|China
MFR|comen|Comen|China
MFR|schiller|Schiller|Switzerland
MFR|welch-allyn|Welch Allyn (Baxter)|USA
MFR|masimo|Masimo|USA
MFR|fukuda-denshi|Fukuda Denshi|Japan
MFR|zoll|Zoll|USA
MFR|bpl-medical|BPL Medical|India
MFR|contec|Contec Medical|China
MFR|hamilton-medical|Hamilton Medical|Switzerland
MFR|mediana|Mediana|South Korea
MFR|skanray|Skanray|India
MFR|infinium-medical|Infinium Medical|USA
MFR|siemens-healthineers|Siemens Healthineers|Germany
DEV|1|philips-intellivue-mx800-hl7|philips|IntelliVue MX800|Philips IntelliVue MX800 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|2|philips-intellivue-mx750-hl7|philips|IntelliVue MX750|Philips IntelliVue MX750 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|3|philips-intellivue-mx700-hl7|philips|IntelliVue MX700|Philips IntelliVue MX700 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|4|philips-intellivue-mx600-hl7|philips|IntelliVue MX600|Philips IntelliVue MX600 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|5|philips-intellivue-mx500-hl7|philips|IntelliVue MX500|Philips IntelliVue MX500 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|6|philips-intellivue-mx400-hl7|philips|IntelliVue MX400|Philips IntelliVue MX400 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|7|philips-intellivue-x3-mx100-hl7|philips|IntelliVue X3 / MX100|Philips IntelliVue X3 / MX100 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|8|philips-intellivue-mp70-mp60-hl7|philips|IntelliVue MP70/MP60|Philips IntelliVue MP70/MP60 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|9|philips-intellivue-mp50-mp40-mp30-hl7|philips|IntelliVue MP50/MP40/MP30|Philips IntelliVue MP50/MP40/MP30 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|10|philips-intellivue-mp20-mp5-hl7|philips|IntelliVue MP20/MP5|Philips IntelliVue MP20/MP5 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|11|philips-earlyvue-vs30-hl7|philips|EarlyVue VS30|Philips EarlyVue VS30 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|12|ge-carescape-b850-hl7|ge|CARESCAPE B850|GE CARESCAPE B850 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hidro_hl7|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok","repair_segments":false}
DEV|13|ge-carescape-b650-hl7|ge|CARESCAPE B650|GE CARESCAPE B650 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hidro_hl7|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok","repair_segments":false}
DEV|14|ge-carescape-b450-hl7|ge|CARESCAPE B450|GE CARESCAPE B450 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hidro_hl7|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok","repair_segments":false}
DEV|15|ge-carescape-b125-hl7|ge|CARESCAPE B125|GE CARESCAPE B125 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hidro_hl7|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok","repair_segments":false}
DEV|16|ge-carescape-one-hl7|ge|CARESCAPE ONE|GE CARESCAPE ONE (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hidro_hl7|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok","repair_segments":false}
DEV|17|ge-solar-8000mi-hl7|ge|Solar 8000M/i|GE Solar 8000M/i (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hidro_hl7|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok","repair_segments":false}
DEV|18|ge-dinamap-procare-v100-hl7|ge|DINAMAP ProCare V100|GE DINAMAP ProCare V100 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hidro_hl7|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok","repair_segments":false}
DEV|19|mindray-benevision-n22-n19-hl7|mindray|BeneVision N22/N19|Mindray BeneVision N22/N19 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|20|mindray-benevision-n17-hl7|mindray|BeneVision N17|Mindray BeneVision N17 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|21|mindray-benevision-n15-hl7|mindray|BeneVision N15|Mindray BeneVision N15 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|22|mindray-benevision-n12-hl7|mindray|BeneVision N12|Mindray BeneVision N12 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|23|mindray-benevision-n1-hl7|mindray|BeneVision N1|Mindray BeneVision N1 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|24|mindray-benevision-v12-v8-v6-hl7|mindray|BeneVision V12/V8/V6|Mindray BeneVision V12/V8/V6 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|25|mindray-epm-15m-12m-10m-hl7|mindray|ePM 15M/12M/10M|Mindray ePM 15M/12M/10M (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|26|mindray-imec-15-12-10-8-hl7|mindray|iMEC 15/12/10/8|Mindray iMEC 15/12/10/8 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|27|mindray-vs-900-800-600-hl7|mindray|VS 900/800/600|Mindray VS 900/800/600 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|28|nihon-kohden-g7-csm-1700-hl7|nihon-kohden|Life Scope G7 (CSM-1700)|Nihon Kohden Life Scope G7 (CSM-1700) (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|29|nihon-kohden-g5-csm-1500-hl7|nihon-kohden|Life Scope G5 (CSM-1500)|Nihon Kohden Life Scope G5 (CSM-1500) (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|30|nihon-kohden-g5-max-hl7|nihon-kohden|Life Scope G5 Max|Nihon Kohden Life Scope G5 Max (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|31|nihon-kohden-e7-bsm-5700-hl7|nihon-kohden|Life Scope E7 (BSM-5700)|Nihon Kohden Life Scope E7 (BSM-5700) (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|32|nihon-kohden-g3-gz-130-140-hl7|nihon-kohden|Life Scope G3 (GZ-130/140)|Nihon Kohden Life Scope G3 (GZ-130/140) (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|33|nihon-kohden-svm-7200-hl7|nihon-kohden|Life Scope SVM-7200|Nihon Kohden Life Scope SVM-7200 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|34|nihon-kohden-bsm-2301k-hl7|nihon-kohden|Life Scope BSM-2301K|Nihon Kohden Life Scope BSM-2301K (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|35|draeger-infinity-vista-xl-hl7|draeger|Infinity Vista XL|Draeger Infinity Vista XL (HL7 v2 via Infinity Gateway)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|36|draeger-infinity-delta-xl-hl7|draeger|Infinity Delta XL|Draeger Infinity Delta XL (HL7 v2 via Infinity Gateway)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|37|draeger-infinity-delta-hl7|draeger|Infinity Delta|Draeger Infinity Delta (HL7 v2 via Infinity Gateway)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|38|draeger-infinity-acs-hl7|draeger|Infinity Acute Care System|Draeger Infinity Acute Care System (HL7 v2 via Infinity Gateway)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|39|draeger-vista-120s|draeger|Vista 120 S|Draeger Vista 120 S patient monitor (CMS link, TCP)|native|patient_monitor|draeger-vista-s|socket|draeger_vista_s|{"transport":"tcp","framing":"raw","auto_ack":false}|{"min_interval_sec":1}
DEV|40|spacelabs-xprezon-hl7|spacelabs|XPREZZON|Spacelabs XPREZZON (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|41|spacelabs-qube-hl7|spacelabs|qube|Spacelabs qube (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|42|spacelabs-elance-hl7|spacelabs|Elance|Spacelabs Elance (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|43|edan-elite-v8-hl7|edan|Elite V8|Edan Elite V8 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|44|edan-im80-hl7|edan|iM80|Edan iM80 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|45|edan-im70-hl7|edan|iM70|Edan iM70 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|46|edan-im60-hl7|edan|iM60|Edan iM60 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|47|edan-im20-im50-hl7|edan|iM20/iM50|Edan iM20/iM50 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|48|biolight-anyview-a8-hl7|biolight|AnyView A8|Biolight AnyView A8 (HL7 v2 option)|hl7-option|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|49|biolight-anyview-a6-a5-hl7|biolight|AnyView A6/A5|Biolight AnyView A6/A5 (HL7 v2 option)|hl7-option|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|51|comen-star-8800-hl7|comen|STAR 8800|Comen STAR 8800 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|52|comen-star-8000-5000-hl7|comen|STAR 8000/STAR 5000|Comen STAR 8000/STAR 5000 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|53|comen-c100-c80-c60-hl7|comen|C100/C80/C60|Comen C100/C80/C60 (HL7 v2 option)|hl7-option|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|54|schiller-argus-pro-lifevue-hl7|schiller|ARGUS PRO LifeVue|Schiller ARGUS PRO LifeVue (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|55|schiller-argus-lcm-plus-hl7|schiller|ARGUS LCM plus|Schiller ARGUS LCM plus (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|56|schiller-ds20-hl7|schiller|DS20|Schiller DS20 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|57|welch-allyn-connex-vsm-6000-hl7|welch-allyn|Connex VSM 6000|Welch Allyn Connex VSM 6000 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|58|welch-allyn-connex-spot-monitor-hl7|welch-allyn|Connex Spot Monitor (CSM)|Welch Allyn Connex Spot Monitor (CSM) (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|60|masimo-root-hl7|masimo|Root|Masimo Root (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|61|masimo-radical-7-hl7|masimo|Radical-7|Masimo Radical-7 (HL7 v2 via Root / Patient SafetyNet)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|62|masimo-patient-safetynet-hl7|masimo|Patient SafetyNet|Masimo Patient SafetyNet (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|63|fukuda-denshi-ds-8900-hl7|fukuda-denshi|DS-8900|Fukuda Denshi DS-8900 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|64|fukuda-denshi-ds-8500-hl7|fukuda-denshi|DS-8500|Fukuda Denshi DS-8500 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|65|fukuda-denshi-ds-8007-hl7|fukuda-denshi|DS-8007|Fukuda Denshi DS-8007 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|66|fukuda-denshi-ds-7700-hl7|fukuda-denshi|Dynascope DS-7700|Fukuda Denshi Dynascope DS-7700 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|67|zoll-propaq-m-hl7|zoll|Propaq M|Zoll Propaq M (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|68|zoll-propaq-md-hl7|zoll|Propaq MD|Zoll Propaq MD (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|69|zoll-x-series-hl7|zoll|X Series|Zoll X Series (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|70|bpl-medical-ultima-prime-hl7|bpl-medical|Ultima Prime|BPL Ultima Prime (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|71|bpl-medical-excello-hl7|bpl-medical|Excello|BPL Excello (HL7 v2 option)|hl7-option|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|72|contec-cms-9200-8000-hl7|contec|CMS 9200/8000|Contec CMS 9200/8000 (HL7 v2 option)|hl7-option|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|74|hamilton-medical-c6-intellicuff-hl7|hamilton-medical|C6 with IntelliCuff|Hamilton Medical C6 with IntelliCuff (HL7 v2)|hl7|ventilator|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|75|mediana-ym6000-hl7|mediana|YM6000|Mediana YM6000 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|76|mediana-ym1000-hl7|mediana|YM1000|Mediana YM1000 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|77|skanray-star-70-60-50-hl7|skanray|Star 70/60/50|Skanray Star 70/60/50 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|78|infinium-medical-omni-k-hl7|infinium-medical|OMNI K|Infinium OMNI K (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|79|infinium-medical-omni-ii-hl7|infinium-medical|OMNI II|Infinium OMNI II (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|80|siemens-healthineers-sc-9000-xl-hl7|siemens-healthineers|SC 9000 XL|Siemens SC 9000 XL (HL7 v2 via Infinity Gateway)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
DEV|81|ge-carescape-b650-dri|ge|CARESCAPE B650|GE CARESCAPE B650 (direct RS-232, S/5 DRI)|native|patient_monitor|ge-s5-dri|serial|ge_dri|{"baud":19200,"data_bits":8,"parity":"even","stop_bits":1,"flow_control":"hardware","dtr":true,"idle_ms":20}|{"checksum_mode":"escaped","dri_levels":[12,11,10,9,8,6]}
DEV|82|ge-carescape-b850-dri|ge|CARESCAPE B850|GE CARESCAPE B850 (direct RS-232, S/5 DRI)|native|patient_monitor|ge-s5-dri|serial|ge_dri|{"baud":19200,"data_bits":8,"parity":"even","stop_bits":1,"flow_control":"hardware","dtr":true,"idle_ms":20}|{"checksum_mode":"escaped","dri_levels":[12,11,10,9,8,6]}
EOF
)
devices() { grep '^DEV|' <<<"$DATA"; }
field() { cut -d'|' -f"$1"; }

list() {
  echo
  printf ' %3s  %-11s  %-15s  %-15s  %-37s  %s\n' "No." "Support" "Parser" "Protocol" "Code" "Model"
  printf ' %3s  %-11s  %-15s  %-15s  %-37s  %s\n' "---" "-----------" "---------------" "---------------" "-------------------------------------" "-----------------------------"
  while IFS='|' read -r _ no code _ _ label support _ protocol _ parser _; do
    printf ' %3s  %-11s  %-15s  %-15s  %-37s  %s\n' "$no" "$support" "$parser" "$protocol" "$code" "$label"
  done < <(devices)
}

post() { # post <path> <json-file> -> prints the HTTP status, body in $WORK/last.txt
  curl -sS -o "$WORK/last.txt" -w '%{http_code}' -u "$GWUSER:$GWPASS" \
       -H 'Content-Type: application/json' --data-binary "@$2" "$GW$1"
}

manufacturer() { # adds the manufacturer when the gateway does not have it yet (409 = already there)
  local line name country
  line=$(grep "^MFR|$1|" <<<"$DATA") || return 0
  name=$(field 3 <<<"$line"); country=$(field 4 <<<"$line")
  printf '{"code":"%s","name":"%s","country":"%s"}\n' "$1" "$name" "$country" > "$WORK/mfr.json"
  if [ "$MODE" = 2 ]; then
    echo "  curl -sS -u \"$GWUSER:********\" -H 'Content-Type: application/json' -d '$(cat "$WORK/mfr.json")' $GW/api/manufacturers"
  else
    post /api/manufacturers "$WORK/mfr.json" >/dev/null
  fi
}

OK=0 EXISTS=0 FAILED=0 SKIPPED=0
create() { # create <no>
  local line
  line=$(devices | grep "^DEV|$1|") || { echo "[$1] not in the list - skipped"; SKIPPED=$((SKIPPED + 1)); return; }
  IFS='|' read -r _ num code mfr model label support category protocol controller parser conn opts <<<"$line"
  echo
  echo "[$num] $label  -  $code  ($support, parser $parser)"
  [ "$support" = hl7-option ] && echo "     note: needs the vendor's HL7 option / module on the monitor"
  manufacturer "$mfr"
  local json="$WORK/$code.json"
  printf '{"code":"%s","label":"%s","manufacturer":"%s","model":"%s","description":"From medical_device_support.pdf #%s (support: %s). Route: %s via %s controller.","category":"%s","protocol":"%s","controller":"%s","parser":"%s","connection_defaults":%s,"default_options":%s}\n' \
    "$code" "$label" "$mfr" "$model" "$num" "$support" "$protocol" "$controller" "$category" "$protocol" "$controller" "$parser" "$conn" "$opts" > "$json"
  echo "  curl -sS -u \"$GWUSER:********\" -H 'Content-Type: application/json' --data-binary @$json $GW/api/device-types"
  if [ "$MODE" = 2 ]; then
    cat "$json"
    return
  fi
  local status
  status=$(post /api/device-types "$json")
  case $status in
    201) echo "  created"; OK=$((OK + 1)) ;;
    409) echo "  already on the gateway"; EXISTS=$((EXISTS + 1)) ;;
    *)   echo "  FAILED (HTTP $status):"; cat "$WORK/last.txt"; echo; FAILED=$((FAILED + 1)) ;;
  esac
}

codes_of() { # codes_of <support|""> -> entry numbers
  local no support
  while IFS='|' read -r _ no _ _ _ _ support _; do
    { [ -z "${1:-}" ] || [ "$support" = "$1" ]; } && echo "$no"
  done < <(devices)
}

# ------------------------------------------------------------------ Flora Root: license device types
# Root keeps, per tenant, the list of device type codes the license allows. This adds the codes of the
# picked models to that list. PUT /api/v1/tenants/<tenant>/license replaces the whole license, so the
# current one is read first and every other field is kept (modules, limits, expiry to the day).
root_license() {
  local overview="$WORK/root-overview.json" body="$WORK/root-license.json" status answer
  echo
  echo "---------------- Flora Root: license of tenant $ROOT_TENANT ----------------"
  status=$(curl -sS "${ROOT_TLS[@]}" -o "$overview" -w '%{http_code}' -u "$ROOTUSER:$ROOTPASS" "$ROOT/api/v1/overview")
  if [ "$status" != 200 ]; then
    echo "Cannot read $ROOT/api/v1/overview (HTTP $status): check the Root URL, username and password."
    return 1
  fi
  local rc
  CODES="${SELECTED_CODES[*]}" TENANT="$ROOT_TENANT" python3 - "$overview" "$body" <<'PY'
import json, math, os, sys, time
overview, body_path = sys.argv[1], sys.argv[2]
tenants = json.load(open(overview)).get("tenants") or []
tenant = next((t for t in tenants if t.get("tenant_id") == os.environ["TENANT"]), None)
if tenant is None:
    sys.exit(f"tenant {os.environ['TENANT']} not found at Root (known: {', '.join(t.get('tenant_id', '?') for t in tenants)})")
if not tenant.get("bundle_id") or tenant.get("revoked_at"):
    sys.exit(f"tenant {tenant['tenant_id']} has no current license (missing or revoked): issue one at Root first")
current = list(tenant.get("device_types") or [])
added = [c for c in os.environ["CODES"].split() if c not in current]
expires = tenant.get("expires_at")
now = time.time() * 1000
days = max(1, min(3650, math.ceil((expires - now) / 86_400_000))) if expires else 365
body = {"modules": tenant.get("modules") or ["leaf", "canopy", "gateway"],
        "max_leaves": tenant.get("max_leaves"), "max_gateways": tenant.get("max_gateways"),
        "max_gateway_devices": tenant.get("max_gateway_devices"),
        "device_types": current + added, "valid_days": days}
json.dump(body, open(body_path, "w"))
fmt = lambda ms: time.strftime("%Y-%m-%d %H:%M", time.localtime(ms / 1000)) if ms else "-"
print(f"tenant      {tenant['tenant_id']}  {tenant.get('name') or ''}")
print(f"license     {tenant['bundle_id']}  (a new bundle id is issued)")
print(f"modules     {', '.join(body['modules'])}   leaves {body['max_leaves']}  gateways {body['max_gateways']}  gateway devices {body['max_gateway_devices']}   (kept)")
print(f"expires     {fmt(expires)}  ->  {fmt(now + days * 86_400_000)}  ({days} days from now)")
print(f"types now   {len(current)}")
print(f"types add   {len(added)}" + ("" if added else "  (all picked codes are already licensed)"))
for code in added:
    print(f"            + {code}")
if not added:
    sys.exit(3)
PY
  rc=$?
  case $rc in 0) ;; 3) return 0 ;; *) return 1 ;; esac
  echo "  curl -sS -k -u \"$ROOTUSER:********\" -X PUT -H 'Content-Type: application/json' --data-binary @$body $ROOT/api/v1/tenants/$ROOT_TENANT/license"
  if [ "$MODE" = 2 ]; then
    cat "$body"; echo
    echo "Dry run: the license was not changed."
    return 0
  fi
  read -r -p "Issue the new license for $ROOT_TENANT? [y/N]: " answer
  [[ ${answer,,} == y* ]] || { echo "Cancelled: the license was not changed."; return 0; }
  status=$(curl -sS "${ROOT_TLS[@]}" -o "$WORK/last.txt" -w '%{http_code}' -u "$ROOTUSER:$ROOTPASS" -X PUT \
           -H 'Content-Type: application/json' --data-binary "@$body" "$ROOT/api/v1/tenants/$ROOT_TENANT/license")
  if [ "$status" = 200 ]; then
    echo "License issued: $(cat "$WORK/last.txt")"
    echo "The tenant's Canopy (Haber) picks it up at its next Root sync; gateways at their next check-in."
  else
    echo "FAILED (HTTP $status):"; cat "$WORK/last.txt"; echo
    return 1
  fi
}

echo "================================================================"
echo " Flora - device types from medical_device_support.pdf"
echo "================================================================"
list

PICK=("$@")
if [ ${#PICK[@]} -eq 0 ]; then
  echo
  echo "Choose entries:"
  echo "  numbers   e.g. 1 2 39  (several separated by spaces)"
  echo "  ALL       every entry above"
  echo "  HL7       HL7 v2 built in                     (support = hl7)"
  echo "  OPT       HL7 v2 with the vendor's HL7 option (support = hl7-option)"
  echo "  NATIVE    dedicated Flora parser              (support = native)"
  echo "  Q         quit"
  read -r -p "Your choice: " -a PICK
fi
[ ${#PICK[@]} -eq 0 ] && exit 0
[[ ${PICK[0]^^} == Q ]] && exit 0

# Picks -> entry numbers (in pick order, no duplicates) and their type codes.
NUMS=() SELECTED_CODES=() SKIPPED=0
for token in "${PICK[@]}"; do
  case ${token^^} in
    ALL)    mapfile -t more < <(codes_of) ;;
    HL7)    mapfile -t more < <(codes_of hl7) ;;
    OPT)    mapfile -t more < <(codes_of hl7-option) ;;
    NATIVE) mapfile -t more < <(codes_of native) ;;
    *)      if devices | grep -q "^DEV|$token|"; then more=("$token"); else echo "[$token] not in the list - skipped"; SKIPPED=$((SKIPPED + 1)); more=(); fi ;;
  esac
  for no in "${more[@]}"; do
    [[ " ${NUMS[*]} " == *" $no "* ]] && continue
    NUMS+=("$no")
    SELECTED_CODES+=("$(devices | grep "^DEV|$no|" | field 3)")
  done
done
[ ${#NUMS[@]} -eq 0 ] && { echo "Nothing picked."; exit 0; }
echo
echo "Picked ${#NUMS[@]} entries: ${SELECTED_CODES[*]}"

if [ -z "$TARGET" ]; then
  echo
  echo "Send to:"
  echo "  1  Flora Root  - add their type codes to the tenant license"
  echo "  2  Flora Gateway - create the device types (parser, connection settings)"
  echo "  3  both"
  read -r -p "Target [1]: " TARGET
fi
case $TARGET in 2|3) ;; *) TARGET=1 ;; esac

if [ -z "$MODE" ]; then
  echo
  echo "Mode:"
  echo "  1  send (runs curl; the Root license asks for confirmation first)"
  echo "  2  only show the curl commands (dry run; Root is only read)"
  read -r -p "Mode [1]: " MODE
fi
[ "$MODE" = 2 ] || MODE=1

RESULT=0
if [ "$TARGET" != 2 ]; then
  read -r -p "Flora Root URL [$ROOT]: " answer && ROOT=${answer:-$ROOT}
  ROOT=${ROOT%/}
  read -r -p "Tenant (hospital code) [$ROOT_TENANT]: " answer && ROOT_TENANT=${answer:-$ROOT_TENANT}
  read -r -p "Root username [$ROOTUSER]: " answer && ROOTUSER=${answer:-$ROOTUSER}
  if [ -z "$ROOTPASS" ]; then read -r -s -p "Root password: " ROOTPASS; echo; fi
  # Root usually runs with a self-signed certificate: verify with FLORA_ROOT_CACERT when given.
  if [ -n "${FLORA_ROOT_CACERT:-}" ]; then ROOT_TLS=(--cacert "$FLORA_ROOT_CACERT"); else ROOT_TLS=(-k); fi
  root_license || RESULT=1
fi

if [ "$TARGET" != 1 ]; then
  echo
  echo "---------------- Flora Gateway: device types ----------------"
  read -r -p "Gateway URL [$GW]: " answer && GW=${answer:-$GW}
  GW=${GW%/}
  if [ "$MODE" = 1 ]; then
    read -r -p "Gateway admin username [$GWUSER]: " answer && GWUSER=${answer:-$GWUSER}
    if [ -z "$GWPASS" ]; then read -r -s -p "Gateway password: " GWPASS; echo; fi
    status=$(curl -sS -o /dev/null -w '%{http_code}' -u "$GWUSER:$GWPASS" "$GW/api/device-types")
    if [ "$status" != 200 ]; then
      echo "Cannot sign in to $GW (HTTP $status). Check the URL, username and password."
      exit 1
    fi
  fi
  for no in "${NUMS[@]}"; do create "$no"; done
  echo
  if [ "$MODE" = 1 ]; then
    echo "Gateway: $OK created, $EXISTS already on the gateway, $FAILED failed."
  else
    echo "Dry run only: nothing was sent to the gateway."
  fi
fi
[ "$SKIPPED" -gt 0 ] && echo "$SKIPPED pick(s) not in the list."
exit $RESULT
