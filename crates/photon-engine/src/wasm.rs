use wasm_bindgen::prelude::*;

use crate::{
    projection::apply_operation,
    types::{Operation, Record},
};

#[wasm_bindgen]
pub fn photon_engine_apply_operation(
    current: JsValue,
    operation: JsValue,
) -> Result<JsValue, JsValue> {
    let current = if current.is_null() || current.is_undefined() {
        None
    } else {
        Some(
            serde_wasm_bindgen::from_value::<Record>(current)
                .map_err(|error| JsValue::from_str(&error.to_string()))?,
        )
    };
    let operation = serde_wasm_bindgen::from_value::<Operation>(operation)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let record = apply_operation(current, &operation)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;

    serde_wasm_bindgen::to_value(&record).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub fn photon_engine_apply_operation_json(
    current_json: Option<String>,
    operation_json: String,
) -> Result<String, JsValue> {
    let current = current_json
        .map(|json| serde_json::from_str::<Record>(&json))
        .transpose()
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let operation = serde_json::from_str::<Operation>(&operation_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let record = apply_operation(current, &operation)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;

    serde_json::to_string(&record).map_err(|error| JsValue::from_str(&error.to_string()))
}
