//! Open case bindings across every Leaf session, and the exclusive/shared rules.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Exclusive,
    Shared,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Exclusive => "exclusive",
            Mode::Shared => "shared",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenBinding {
    pub row_id: i64,
    pub session_id: String,
    pub leaf_id: String,
    pub case_uuid: String,
    pub device_id: String,
    pub mode: Mode,
}

#[derive(Debug, PartialEq)]
pub enum Decision {
    /// The same session already holds this (case, device) in this mode.
    Existing(i64),
    /// Open a new binding. `replace` holds bindings to close first: this session's own row
    /// when the mode changed, and the same Leaf's rows for this case on sessions it left
    /// behind (a reconnect seen before the old socket timed out).
    Open { replace: Vec<OpenBinding> },
    Conflict(String),
}

#[derive(Debug, Default)]
pub struct Registry {
    pub bindings: Vec<OpenBinding>,
}

impl Registry {
    pub fn decide(&self, session_id: &str, leaf_id: &str, case_uuid: &str, device_id: &str, mode: Mode) -> Decision {
        let mut replace = Vec::new();
        let mut others = Vec::new();
        for binding in self.bindings.iter().filter(|binding| binding.device_id == device_id) {
            let same_case = binding.case_uuid == case_uuid;
            if same_case && binding.session_id == session_id {
                if binding.mode == mode {
                    return Decision::Existing(binding.row_id);
                }
                replace.push(binding.clone());
            } else if same_case && binding.leaf_id == leaf_id {
                replace.push(binding.clone());
            } else {
                others.push(binding);
            }
        }
        let blocking = match mode {
            Mode::Exclusive => others.first(),
            Mode::Shared => others.iter().find(|binding| binding.mode == Mode::Exclusive),
        };
        match blocking {
            Some(binding) => Decision::Conflict(format!(
                "device {device_id} is bound {} by case {} on leaf {}",
                binding.mode.as_str(), binding.case_uuid, binding.leaf_id
            )),
            None => Decision::Open { replace },
        }
    }

    pub fn remove_rows(&mut self, rows: &[i64]) -> Vec<OpenBinding> {
        let (removed, kept) = std::mem::take(&mut self.bindings).into_iter().partition(|binding| rows.contains(&binding.row_id));
        self.bindings = kept;
        removed
    }

    pub fn session_rows(&self, session_id: &str) -> Vec<i64> {
        self.bindings.iter().filter(|binding| binding.session_id == session_id).map(|binding| binding.row_id).collect()
    }
}
