//! Bounded, serializable record interests. This is filtering, never authorization.
use crate::{CollectionName, EngineError, Record, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordSelection {
    pub collection: CollectionName,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filters: Option<Vec<SelectionFilter>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectionFilter {
    pub field: String,
    pub op: String,
    pub value: Value,
}

impl RecordSelection {
    pub fn validate(&self) -> Result<()> {
        let bad = || EngineError::Storage("invalid record selection".into());
        if self.collection.as_str().is_empty() || self.collection.as_str().len() > 256 {
            return Err(bad());
        }
        if let Some(ids) = &self.record_ids {
            if ids.len() > 1000 || ids.iter().any(|id| id.is_empty() || id.len() > 512) {
                return Err(bad());
            }
        }
        if let Some(filters) = &self.filters {
            if filters.len() > 32 {
                return Err(bad());
            }
            for filter in filters {
                if filter.field.len() > 256
                    || !filter.field.split('.').all(|part| {
                        let mut chars = part.chars();
                        chars
                            .next()
                            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
                    })
                {
                    return Err(bad());
                }
                let scalar =
                    |v: &Value| v.is_null() || v.is_string() || v.is_number() || v.is_boolean();
                let valid = match filter.op.as_str() {
                    "eq" | "ne" => scalar(&filter.value),
                    "gt" | "gte" | "lt" | "lte" => {
                        filter.value.is_number() || filter.value.is_string()
                    }
                    "in" => filter
                        .value
                        .as_array()
                        .is_some_and(|a| a.len() <= 1000 && a.iter().all(scalar)),
                    "exists" => filter.value.is_boolean(),
                    _ => false,
                };
                if !valid {
                    return Err(bad());
                }
            }
        }
        Ok(())
    }

    pub fn matches(&self, record: &Record) -> bool {
        if record.deleted_at.is_some() || record.key.collection != self.collection {
            return false;
        }
        if self
            .record_ids
            .as_ref()
            .is_some_and(|ids| !ids.iter().any(|id| id == record.key.record_id.as_str()))
        {
            return false;
        }
        self.filters
            .as_deref()
            .unwrap_or_default()
            .iter()
            .all(|filter| {
                let mut value = Some(&record.value);
                for part in filter.field.split('.') {
                    value = value.and_then(|v| v.get(part));
                }
                let compare = || -> Option<std::cmp::Ordering> {
                    let actual = value?;
                    if let (Some(a), Some(b)) = (actual.as_f64(), filter.value.as_f64()) {
                        return a.partial_cmp(&b);
                    }
                    if let (Some(a), Some(b)) = (actual.as_str(), filter.value.as_str()) {
                        return Some(a.cmp(b));
                    }
                    None
                };
                match filter.op.as_str() {
                    "exists" => value.is_some() == filter.value.as_bool().unwrap_or(false),
                    "eq" => value.is_some_and(|v| json_equal(v, &filter.value)),
                    "ne" => !value.is_some_and(|v| json_equal(v, &filter.value)),
                    "in" => filter
                        .value
                        .as_array()
                        .is_some_and(|a| value.is_some_and(|v| a.iter().any(|x| json_equal(v, x)))),
                    "gt" => compare() == Some(std::cmp::Ordering::Greater),
                    "gte" => compare().is_some_and(|c| !c.is_lt()),
                    "lt" => compare() == Some(std::cmp::Ordering::Less),
                    "lte" => compare().is_some_and(|c| !c.is_gt()),
                    _ => false,
                }
            })
    }
}

fn json_equal(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(a), Some(b)) => a == b,
        _ => a == b,
    }
}

/// JSON paths and values are *all* bound parameters. No user input is SQL.
/// The two SQL adapters have identical predicates; only JSON type names differ.
#[cfg(any(feature = "sqlite", feature = "mysql"))]
pub(crate) fn selection_sql(selection: &RecordSelection, mysql: bool) -> (String, Vec<String>) {
    let mut clauses = vec!["json_extract(record_json, '$.deleted_at') IS NULL".to_owned()];
    if mysql {
        clauses[0] = "JSON_TYPE(JSON_EXTRACT(record_json, '$.deleted_at')) = 'NULL'".into();
    }
    let mut params = Vec::new();
    if let Some(ids) = &selection.record_ids {
        clauses.push(if ids.is_empty() {
            "1 = 0".into()
        } else {
            format!("record_id IN ({})", vec!["?"; ids.len()].join(","))
        });
        params.extend(ids.iter().cloned());
    }
    for filter in selection.filters.as_deref().unwrap_or_default() {
        let path = format!("$.value.{}", filter.field);
        if filter.op == "exists" {
            let ty = if mysql {
                "JSON_TYPE(JSON_EXTRACT(record_json, ?))"
            } else {
                "json_type(record_json, ?)"
            };
            clauses.push(format!(
                "{ty} IS {}NULL",
                if filter.value == true { "NOT " } else { "" }
            ));
            params.push(path);
            continue;
        }
        let values = if filter.op == "in" {
            filter.value.as_array().cloned().unwrap_or_default()
        } else {
            vec![filter.value.clone()]
        };
        let mut alternatives = Vec::new();
        for value in values {
            let ty = if mysql {
                "JSON_TYPE(JSON_EXTRACT(record_json, ?))"
            } else {
                "json_type(record_json, ?)"
            };
            let types = if value.is_null() {
                if mysql {
                    "'NULL'"
                } else {
                    "'null'"
                }
            } else if value.is_string() {
                if mysql {
                    "'STRING'"
                } else {
                    "'text'"
                }
            } else if value.is_boolean() {
                if mysql {
                    "'BOOLEAN'"
                } else if value == true {
                    "'true'"
                } else {
                    "'false'"
                }
            } else if mysql {
                "'INTEGER','DOUBLE','DECIMAL'"
            } else {
                "'integer','real'"
            };
            params.push(path.clone());
            if value.is_null() || (!mysql && value.is_boolean()) {
                alternatives.push(format!("({ty} IN ({types}))"));
            } else {
                let op = match filter.op.as_str() {
                    "gt" => ">",
                    "gte" => ">=",
                    "lt" => "<",
                    "lte" => "<=",
                    _ => "=",
                };
                alternatives.push(format!("({ty} IN ({types}) AND json_extract(record_json, ?) {op} json_extract(?, '$'))"));
                params.push(path.clone());
                params.push(value.to_string());
            }
        }
        let clause = if alternatives.is_empty() {
            "1 = 0".into()
        } else {
            alternatives.join(" OR ")
        };
        clauses.push(if filter.op == "ne" {
            format!("NOT COALESCE(({clause}), FALSE)")
        } else {
            format!("({clause})")
        });
    }
    (clauses.join(" AND "), params)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordCheckpoint {
    pub record: Record,
    pub sequence: i64,
}
