//! Parse the fields a domain consumes without allocating unused JSON trees.
//!
//! Selected values retain their JSON types and insertion order. Unexpected
//! shapes pass through unchanged, so domain validation and fallbacks still
//! decide what malformed data means. Discarded values are parsed with the
//! same numeric and nesting checks as retained values.

use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::fmt;

#[derive(Clone, Copy)]
pub(crate) enum Projection {
    All,
    Fields(&'static [(&'static str, Projection)]),
    Values(&'static Projection),
    Elements(&'static Projection),
    Discard,
}

pub(crate) fn from_str(text: &str, projection: Projection) -> Result<Value, serde_json::Error> {
    let mut de = serde_json::Deserializer::from_str(text);
    let value = projection.deserialize(&mut de)?;
    de.end()?;
    Ok(value)
}

impl<'de> DeserializeSeed<'de> for Projection {
    type Value = Value;

    fn deserialize<D: serde::Deserializer<'de>>(self, de: D) -> Result<Value, D::Error> {
        if matches!(self, Self::All) {
            Value::deserialize(de)
        } else {
            de.deserialize_any(self)
        }
    }
}

impl Projection {
    fn keep(self, value: impl FnOnce() -> Value) -> Value {
        if matches!(self, Self::Discard) {
            Value::Null
        } else {
            value()
        }
    }
}

impl<'de> Visitor<'de> for Projection {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }

    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_bool<E>(self, value: bool) -> Result<Value, E> {
        Ok(self.keep(|| Value::Bool(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Value, E> {
        Ok(self.keep(|| value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Value, E> {
        Ok(self.keep(|| value.into()))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Value, E> {
        Ok(self.keep(|| value.into()))
    }

    fn visit_str<E>(self, value: &str) -> Result<Value, E> {
        Ok(self.keep(|| Value::String(value.to_owned())))
    }

    fn visit_string<E>(self, value: String) -> Result<Value, E> {
        Ok(self.keep(|| Value::String(value)))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let discard = matches!(self, Self::Discard);
        let child = match self {
            Self::Discard => Self::Discard,
            Self::Elements(child) => *child,
            _ => Self::All,
        };
        let mut values = Vec::new();
        while let Some(value) = seq.next_element_seed(child)? {
            if !discard {
                values.push(value);
            }
        }
        Ok(self.keep(|| Value::Array(values)))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            let child = match self {
                Self::Fields(fields) => fields
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, child)| *child)
                    .unwrap_or(Self::Discard),
                Self::Values(child) => *child,
                Self::Elements(_) => Self::All,
                other => other,
            };
            let value = map.next_value_seed(child)?;
            if !matches!(child, Self::Discard) {
                values.insert(key, value);
            }
        }
        Ok(self.keep(|| Value::Object(values)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const FIELDS: Projection = Projection::Fields(&[("kept", Projection::All)]);

    #[test]
    fn preserves_selected_types_order_and_duplicate_key_semantics() {
        let value = from_str(r#"{"z":{"kept":null,"unused":[]},"a":{"kept":{"b":2,"a":1},"unused":false},"n":7,"s":"x","array":[{"unknown":true}],"dup":{"kept":1,"kept":2}}"#,
            Projection::Values(&FIELDS)).unwrap();
        assert_eq!(
            serde_json::to_string(&value).unwrap(),
            r#"{"z":{"kept":null},"a":{"kept":{"b":2,"a":1}},"n":7,"s":"x","array":[{"unknown":true}],"dup":{"kept":2}}"#
        );
    }

    #[test]
    fn discarded_fields_still_validate_numbers_syntax_and_depth() {
        for text in [
            r#"{"unused":1e999}"#,
            r#"{"unused":[1,]}"#,
            r#"{"unused":"\uD800"}"#,
            r#"{"kept":1} []"#,
        ] {
            assert!(serde_json::from_str::<Value>(text).is_err());
            assert!(from_str(text, FIELDS).is_err(), "{text}");
        }
        let deep = format!("{{\"unused\":{}0{}}}", "[".repeat(140), "]".repeat(140));
        assert!(from_str(&deep, FIELDS).is_err());
        for text in ["null", "42", "-0.0", "[1,{}]", "true", r#""a\nb""#] {
            assert_eq!(
                from_str(text, FIELDS).unwrap(),
                serde_json::from_str::<Value>(text).unwrap()
            );
        }
    }

    #[test]
    fn array_projection_preserves_non_array_shapes() {
        let projection = Projection::Elements(&FIELDS);
        assert_eq!(
            from_str(r#"[{"kept":1,"unused":2},null,7]"#, projection).unwrap(),
            serde_json::json!([{"kept":1},null,7])
        );
        for text in [r#"{"nested":[{"unused":2}]}"#, "null", "42"] {
            assert_eq!(
                from_str(text, projection).unwrap(),
                serde_json::from_str::<Value>(text).unwrap()
            );
        }
    }
}
