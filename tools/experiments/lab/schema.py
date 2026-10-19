"""Validate the JSON Schema subset used by the shipped v1 contracts."""
import math
import re

from .integrity import LabError


def validate(value, schema, document=None, location="$", depth=0):
    document = schema if document is None else document
    if depth > 80:
        raise LabError(location + ": configuration nesting is too deep")
    if "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/"):
            raise LabError("Only document-local schema references are supported")
        target = document
        for key in ref[2:].split("/"):
            target = target[key.replace("~1", "/").replace("~0", "~")]
        return validate(value, target, document, location, depth + 1)
    if "anyOf" in schema:
        for option in schema["anyOf"]:
            try:
                validate(value, option, document, location, depth + 1)
                return
            except LabError:
                pass
        raise LabError(location + ": no supported shape matches")
    types = {"object": lambda x: isinstance(x, dict),
             "array": lambda x: isinstance(x, list),
             "string": lambda x: isinstance(x, str),
             "boolean": lambda x: isinstance(x, bool),
             "integer": lambda x: isinstance(x, int) and not isinstance(x, bool),
             "number": lambda x: isinstance(x, (float, int)) and not isinstance(x, bool)
             and math.isfinite(x), "null": lambda x: x is None}
    if "type" in schema and not types[schema["type"]](value):
        raise LabError(location + ": expected " + schema["type"])
    if "enum" in schema and not any(value == item and isinstance(value, bool) == isinstance(item, bool)
                                        for item in schema["enum"]):
        raise LabError(location + ": unsupported value")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                raise LabError(location + ": missing " + key)
        properties = schema.get("properties", {})
        additional = schema.get("additionalProperties", True)
        for key, item in value.items():
            if "propertyNames" in schema:
                validate(key, schema["propertyNames"], document, location, depth + 1)
            if key in properties:
                validate(item, properties[key], document, location + "." + key, depth + 1)
            elif additional is False:
                raise LabError(location + ": unknown field " + key)
            elif isinstance(additional, dict):
                validate(item, additional, document, location + "." + key, depth + 1)
        if len(value) < schema.get("minProperties", 0):
            raise LabError(location + ": too few entries")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", float("inf")):
            raise LabError(location + ": array length is out of bounds")
        for index, item in enumerate(value):
            validate(item, schema.get("items", {}), document,
                     location + "[" + str(index) + "]", depth + 1)
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", float("inf")):
            raise LabError(location + ": string length is out of bounds")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            raise LabError(location + ": invalid format")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value < schema.get("minimum", -float("inf")) or value > schema.get("maximum", float("inf")):
            raise LabError(location + ": value is out of bounds")
