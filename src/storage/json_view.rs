//! Borrowed reads shared by mutable JSON results and immutable cached JSON.
use super::frozen::FrozenValue;
use serde_json::Value;

#[derive(Clone, Copy)]
pub(crate) enum JsonView<'a> {
    Value(&'a Value),
    Frozen(&'a FrozenValue),
}
impl<'a> JsonView<'a> {
    pub fn get(self, key: &str) -> Option<Self> {
        match self {
            Self::Value(v) => v.get(key).map(Self::Value),
            Self::Frozen(v) => v.get(key).map(Self::Frozen),
        }
    }
    pub fn as_str(self) -> Option<&'a str> {
        match self {
            Self::Value(v) => v.as_str(),
            Self::Frozen(v) => v.as_str(),
        }
    }
    pub fn as_f64(self) -> Option<f64> {
        match self {
            Self::Value(v) => v.as_f64(),
            Self::Frozen(FrozenValue::Number(v)) => v.as_f64(),
            _ => None,
        }
    }
    pub fn as_bool(self) -> Option<bool> {
        match self {
            Self::Value(v) => v.as_bool(),
            Self::Frozen(FrozenValue::Bool(v)) => Some(*v),
            _ => None,
        }
    }
    pub fn is_null(self) -> bool {
        matches!(
            self,
            Self::Value(Value::Null) | Self::Frozen(FrozenValue::Null)
        )
    }
    pub fn is_number(self) -> bool {
        matches!(
            self,
            Self::Value(Value::Number(_)) | Self::Frozen(FrozenValue::Number(_))
        )
    }
    pub fn truthy(self) -> bool {
        if self.is_null() {
            false
        } else if let Some(v) = self.as_bool() {
            v
        } else if self.is_number() {
            self.as_f64().is_some_and(|v| v != 0.0 && !v.is_nan())
        } else if let Some(v) = self.as_str() {
            !v.is_empty()
        } else {
            true
        }
    }
    pub fn to_value(self) -> Value {
        match self {
            Self::Value(v) => v.clone(),
            Self::Frozen(v) => v.to_value(),
        }
    }
    pub fn array(self) -> impl Iterator<Item = Self> {
        let (values, frozen): (&[Value], &[FrozenValue]) = match self {
            Self::Value(Value::Array(v)) => (v, &[]),
            Self::Frozen(FrozenValue::Array(v)) => (&[], v),
            _ => (&[], &[]),
        };
        values
            .iter()
            .map(Self::Value)
            .chain(frozen.iter().map(Self::Frozen))
    }
}
