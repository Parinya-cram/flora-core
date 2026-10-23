"""Gateway parameter (ivy_param) -> vital_minutes key, and the per-minute value choice.

Shared by the minute pull (device_writer.py) and the live stream roll-up (live/).
"""
import math

PARAMETERS = {
    "hr":"hr", "heart_rate":"hr", "pulse_rate":"pr", "spo2_pr":"pr", "pr":"pr", "art_pr":"art_pr",
    "spo2":"spo2", "resp_rate":"rr", "rr":"rr", "etco2":"etco2", "temperature":"temperature",
    "temp1":"temperature", "temp2":"temperature", "temp3":"temperature", "temp4":"temperature",
    "nibp_sys":"nibp_sys", "nibp_dia":"nibp_dia", "nibp_mean":"nibp_map", "nibp_map":"nibp_map",
    "art_sys":"art_sys", "art_dia":"art_dia", "art_mean":"art_map", "art_map":"art_map", "cvp":"cvp",
    "vent_mode":"set_vent_mode", "tidal_volume_exp":"tidal_volume_exp", "minute_volume":"minute_volume_exp",
    "minute_volume_exp":"minute_volume_exp", "fio2":"fio2", "airway_pressure_peak":"airway_pressure_peak",
    "airway_pressure_plat":"airway_pressure_plateau", "airway_pressure_plateau":"airway_pressure_plateau",
    "airway_pressure_mean":"airway_pressure_mean", "airway_pressure_min":"airway_pressure_min", "mv_spont":"mv_spont",
    "rr_spont":"rr_spont", "peep_intrinsic":"peep_intrinsic", "compliance":"compliance",
    "peep_extrinsic":"peep_extrinsic", "peep_total":"peep_total", "fio2_meas":"fio2_meas", "et_o2":"et_o2",
    "fi_co2":"fi_co2", "et_co2":"et_co2", "fi_agent":"fi_agent", "et_agent":"et_agent", "agent_id":"agent_id",
    "fi_n2o":"fi_n2o", "et_n2o":"et_n2o", "mac":"mac", "flow_o2":"flow_o2", "flow_n2o":"flow_n2o",
    "flow_air":"flow_air", "set_vent_mode":"set_vent_mode", "tv_set":"set_tidal_volume",
    "set_tidal_volume":"set_tidal_volume", "rr_set":"set_rr", "set_rr":"set_rr", "ie_ratio":"set_ie_ratio",
    "set_ie_ratio":"set_ie_ratio", "peep_set":"set_peep", "set_peep":"set_peep", "peak_limit":"set_peak_limit",
    "set_peak_limit":"set_peak_limit", "insp_pres_set":"set_insp_pressure", "set_insp_pressure":"set_insp_pressure",
    "fio2_set":"set_fio2", "set_fio2":"set_fio2", "fgf_total":"set_fgf_total", "set_fgf_total":"set_fgf_total",
    "psupp":"set_psupp", "set_psupp":"set_psupp", "flow_trigger":"set_flow_trigger",
    "set_flow_trigger":"set_flow_trigger", "end_flow":"set_end_flow", "set_end_flow":"set_end_flow",
    "t_insp_set":"set_t_insp", "set_t_insp":"set_t_insp", "etaa":"et_agent", "fiaa":"fi_agent",
    "unknown::147842":"hr", "unknown::149530":"pr", "unknown::149522":"art_pr", "unknown::150456":"spo2",
    "unknown::150021":"nibp_sys", "unknown::150022":"nibp_dia", "unknown::150023":"nibp_map",
    "unknown::mdc_press_bld_noninv_sys":"nibp_sys", "unknown::mdc_press_bld_noninv_dia":"nibp_dia",
    "unknown::mdc_press_bld_noninv_mean":"nibp_map", "unknown::150087":"cvp",
    "unknown::measured fi anesthetic agent conc fiaa":"fi_agent",
    "unknown::measured end tidal anesthetic agent conc etaa":"et_agent",
}


def minute_payload(rows) -> dict:
    """One vital_minutes payload from a minute of observation rows, in time order: the first value of each
    key wins; for CO2 a mmHg reading beats kPa beats %."""
    selected = {}
    for row in rows:
        key = PARAMETERS.get(str(row.get("ivy_param", "")).strip().lower())
        if not key:
            continue
        value, priority = row.get("value"), 0
        if key in {"et_co2", "fi_co2"} and isinstance(value, (int, float)) and math.isfinite(value):
            unit = str(row.get("unit", "")).strip().lower()
            if unit == "mmhg": priority = 3
            elif unit == "kpa": value, priority = round(value * 7.50062, 1), 2
            elif unit == "%": value, priority = round(value * 7.6, 1), 1
        if key not in selected or priority > selected[key][1]:
            selected[key] = (value, priority)
    return {key: value[0] for key, value in selected.items()}


def latest_values(rows) -> dict:
    """Live display: the last value of each key (same CO2 preference)."""
    return minute_payload(list(reversed(list(rows))))
