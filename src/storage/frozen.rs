//! Immutable JSON trees for generation-owned caches. Numbers and object order
//! remain lossless; field names share allocations within one parsed document.

use super::projection::Projection;
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::{Number, Value};
use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

type Keys = HashMap<String, Arc<str>>;

#[derive(Debug)]
pub enum FrozenValue {
    Null,
    Bool(bool),
    Number(Number),
    String(Box<str>),
    Array(Box<[FrozenValue]>),
    Object(Box<[(Arc<str>, FrozenValue)]>),
}

impl FrozenValue {
    pub fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(values) => values
                .iter()
                .find(|(k, _)| k.as_ref() == key)
                .map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s),
            _ => None,
        }
    }
    pub fn is_object(&self) -> bool {
        matches!(self, Self::Object(_))
    }
    pub fn is_array(&self) -> bool {
        matches!(self, Self::Array(_))
    }
    pub fn take(&mut self, key: &str) -> Self {
        if let Self::Object(values) = self {
            if let Some((_, v)) = values.iter_mut().find(|(k, _)| k.as_ref() == key) {
                return std::mem::replace(v, Self::Null);
            }
        }
        Self::Null
    }
    /// Materialize only a selected subtree for dynamic output/override merging.
    pub fn to_value(&self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(v) => Value::Bool(*v),
            Self::Number(v) => Value::Number(v.clone()),
            Self::String(s) => Value::String(s.to_string()),
            Self::Array(a) => Value::Array(a.iter().map(Self::to_value).collect()),
            Self::Object(o) => Value::Object(
                o.iter()
                    .map(|(k, v)| (k.to_string(), v.to_value()))
                    .collect(),
            ),
        }
    }
}

pub(crate) fn from_str(
    text: &str,
    projection: Projection,
) -> Result<FrozenValue, serde_json::Error> {
    let mut keys = Keys::new();
    let mut de = serde_json::Deserializer::from_str(text);
    let value = Seed {
        projection,
        keys: &mut keys,
    }
    .deserialize(&mut de)?;
    de.end()?;
    Ok(value)
}

// Borrow unescaped keys while parsing; interned keys own their data after parsing.
struct Key<'a>(Cow<'a, str>);
impl<'de> Deserialize<'de> for Key<'de> {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        struct KeyVisitor;
        impl<'de> Visitor<'de> for KeyVisitor {
            type Value = Key<'de>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a string")
            }
            fn visit_borrowed_str<E>(self, v: &'de str) -> Result<Self::Value, E> {
                Ok(Key(Cow::Borrowed(v)))
            }
            fn visit_str<E>(self, v: &str) -> Result<Self::Value, E> {
                Ok(Key(Cow::Owned(v.to_owned())))
            }
            fn visit_string<E>(self, v: String) -> Result<Self::Value, E> {
                Ok(Key(Cow::Owned(v)))
            }
        }
        de.deserialize_str(KeyVisitor)
    }
}

struct Seed<'a> {
    projection: Projection,
    keys: &'a mut Keys,
}
impl<'de> DeserializeSeed<'de> for Seed<'_> {
    type Value = FrozenValue;
    fn deserialize<D: serde::Deserializer<'de>>(self, de: D) -> Result<Self::Value, D::Error> {
        if matches!(self.projection, Projection::Discard) {
            self.projection.deserialize(de)?;
            Ok(FrozenValue::Null)
        } else {
            de.deserialize_any(self)
        }
    }
}
impl<'de> Visitor<'de> for Seed<'_> {
    type Value = FrozenValue;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(FrozenValue::Null)
    }
    fn visit_bool<E>(self, v: bool) -> Result<Self::Value, E> {
        Ok(FrozenValue::Bool(v))
    }
    fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E> {
        Ok(FrozenValue::Number(v.into()))
    }
    fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E> {
        Ok(FrozenValue::Number(v.into()))
    }
    fn visit_f64<E>(self, v: f64) -> Result<Self::Value, E> {
        Ok(Number::from_f64(v)
            .map(FrozenValue::Number)
            .unwrap_or(FrozenValue::Null))
    }
    fn visit_str<E>(self, v: &str) -> Result<Self::Value, E> {
        Ok(FrozenValue::String(v.into()))
    }
    fn visit_string<E>(self, v: String) -> Result<Self::Value, E> {
        Ok(FrozenValue::String(v.into_boxed_str()))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let child = match self.projection {
            Projection::Elements(p) => *p,
            _ => Projection::All,
        };
        let mut values = Vec::new();
        while let Some(value) = seq.next_element_seed(Seed {
            projection: child,
            keys: &mut *self.keys,
        })? {
            values.push(value);
        }
        Ok(FrozenValue::Array(values.into_boxed_slice()))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut values: Vec<(Arc<str>, FrozenValue)> = Vec::new();
        // Small objects avoid a temporary hash table. Wide roots use a lookup
        // table so duplicate detection does not become quadratic.
        let mut positions: Option<HashMap<Arc<str>, usize>> = None;
        while let Some(Key(key)) = map.next_key::<Key>()? {
            let child = match self.projection {
                Projection::Fields(fields) => fields
                    .iter()
                    .find(|(k, _)| *k == key.as_ref())
                    .map(|(_, p)| *p)
                    .unwrap_or(Projection::Discard),
                Projection::Values(p) => *p,
                _ => Projection::All,
            };
            let value = map.next_value_seed(Seed {
                projection: child,
                keys: &mut *self.keys,
            })?;
            if matches!(child, Projection::Discard) {
                continue;
            }
            let existing = match &positions {
                Some(p) => p.get(key.as_ref()).copied(),
                None => values.iter().position(|(k, _)| k.as_ref() == key.as_ref()),
            };
            if let Some(index) = existing {
                values[index].1 = value;
                continue;
            }
            let key = if let Some(shared) = self.keys.get(key.as_ref()) {
                Arc::clone(shared)
            } else {
                let shared: Arc<str> = Arc::from(key.as_ref());
                self.keys.insert(key.into_owned(), Arc::clone(&shared));
                shared
            };
            if let Some(p) = positions.as_mut() {
                p.insert(Arc::clone(&key), values.len());
            }
            values.push((key, value));
            if positions.is_none() && values.len() == 16 {
                positions = Some(
                    values
                        .iter()
                        .enumerate()
                        .map(|(i, (k, _))| (Arc::clone(k), i))
                        .collect(),
                );
            }
        }
        Ok(FrozenValue::Object(values.into_boxed_slice()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_projected_json_order_values_and_parser_errors() {
        const ROW: Projection = Projection::Fields(&[("kept", Projection::All)]);
        let projections = [
            Projection::All,
            Projection::Fields(&[("rows", Projection::Elements(&ROW))]),
            Projection::Values(&ROW),
            Projection::Elements(&ROW),
        ];
        let mut cases = vec![
            "null".into(),
            "false".into(),
            "-0.0".into(),
            "18446744073709551615".into(),
            "-9223372036854775808".into(),
            "1.2345678901234567".into(),
            "\"a\\n🙂\\u0062\"".into(),
            r#"{"rows":[{"kept":1,"ignored":2},null,{"kept":{"b":2,"a":1}}],"rows":false}"#.into(),
            r#"{"x":1,"x":null,"nested":{"kept":[1,{},null]}}"#.into(),
            r#"{"ignored":1e999}"#.into(),
            r#"{"kept":"\uD800"}"#.into(),
            r#"{"x":[1,]}"#.into(),
            "true false".into(),
        ];
        let wide = (0..80)
            .map(|n| format!("\"k{n}\":{n}"))
            .chain(["\"k0\":-0.0".into(), "\"k31\":false".into()])
            .collect::<Vec<_>>()
            .join(",");
        cases.push(format!("{{{wide}}}"));
        cases.push(r#"{"same":1,"\u0073ame":2,"中文\n":3}"#.into());
        cases.push("{1:2}".into());
        for depth in 0..145 {
            cases.push(format!("{}0{}", "[".repeat(depth), "]".repeat(depth)));
            cases.push(format!(
                "{{\"ignored\":{}1e999{}}}",
                "[".repeat(depth),
                "]".repeat(depth)
            ));
        }
        for text in cases {
            for p in projections {
                let expected = super::super::projection::from_str(&text, p)
                    .map(|v| serde_json::to_string(&v).unwrap())
                    .map_err(|e| e.to_string());
                let actual = from_str(&text, p)
                    .map(|v| serde_json::to_string(&v.to_value()).unwrap())
                    .map_err(|e| e.to_string());
                assert_eq!(expected, actual, "{text}");
            }
        }
    }
    #[test]
    fn keys_share_within_document_and_release_with_last_tree() {
        let value = from_str(r#"[{"same":1},{"same":2}]"#, Projection::All).unwrap();
        let FrozenValue::Array(rows) = &value else {
            panic!()
        };
        let (FrozenValue::Object(a), FrozenValue::Object(b)) = (&rows[0], &rows[1]) else {
            panic!()
        };
        assert!(Arc::ptr_eq(&a[0].0, &b[0].0));
        let weak = Arc::downgrade(&a[0].0);
        drop(value);
        assert!(weak.upgrade().is_none());
    }
}
