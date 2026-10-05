"use strict";
// A JavaScript port of the validation rules in Gecko's Schemas.sys.mjs (as
// shipped in Thunderbird 153's omni.ja, modules/Schemas.sys.mjs), applied to
// the real JSON schemas loaded by ./omni.js. Line references below are to that
// file. Only validation is ported; injection is modelled in ./api.js.

const MIN_MANIFEST_VERSION = 2;
const MAX_MANIFEST_VERSION = 3;

class SchemaValidationError extends Error {}

// Schemas.sys.mjs:378 parsePattern
function parsePattern(pattern) {
  let flags = "";
  const match = /^\(\?([im]*)\)(.*)/.exec(pattern);
  if (match) [, flags, pattern] = match;
  return new RegExp(pattern, flags);
}

// Schemas.sys.mjs:387 getValueBaseType
function tryParseUrl(string) {
  try {
    return new URL(string);
  } catch {
    return null;
  }
}

function getValueBaseType(value) {
  const type = typeof value;
  switch (type) {
    case "object":
      if (value === null) return "null";
      if (Array.isArray(value)) return "array";
      break;
    case "number":
      if (value % 1 === 0) return "integer";
  }
  return type;
}

// Schemas.sys.mjs:1163 FORMATS (the subset that does not need Gecko services).
const FORMATS = {
  hostname(string) {
    if (tryParseUrl(`http://${string}`)?.host !== string) throw new Error(`Invalid hostname ${string}`);
    return string;
  },
  canonicalDomain(string) {
    if (tryParseUrl(`http://${string}`)?.hostname !== string) throw new Error(`Invalid domain ${string}`);
    return string;
  },
  url(string) {
    return new URL(string).href;
  },
  origin(string) {
    const url = new URL(string);
    if (!/^https?:/.test(url.protocol)) throw new Error(`Invalid origin must be http or https for URL ${string}`);
    if (string.endsWith("/") || url.href != new URL(url.origin).href) {
      throw new Error(`Invalid origin for URL ${string}, replace with origin ${url.origin}`);
    }
    return url.origin;
  },
  relativeUrl(string, ctx) {
    if (!ctx.url && !URL.canParse(string)) return string;
    return new URL(string, ctx.url).href;
  },
  strictRelativeUrl(string, ctx) {
    FORMATS.unresolvedRelativeUrl(string);
    return FORMATS.relativeUrl(string, ctx);
  },
  unresolvedRelativeUrl(string) {
    if (!string.startsWith("//") && !URL.canParse(string)) return string;
    throw new SyntaxError(`String ${JSON.stringify(string)} must be a relative URL`);
  },
  homepageUrl(string, ctx) {
    return FORMATS.relativeUrl(string.replace(/\|/g, "%7C"), ctx);
  },
  imageDataOrStrictRelativeUrl(string, ctx) {
    if (!string.startsWith("data:image/png;base64,") && !string.startsWith("data:image/jpeg;base64,")) {
      try {
        return FORMATS.strictRelativeUrl(string, ctx);
      } catch {
        throw new SyntaxError(`String ${JSON.stringify(string)} must be a relative or PNG or JPG data:image URL`);
      }
    }
    return string;
  },
  date(string) {
    const PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|([-+]\d{2}:?\d{2})))?$/;
    if (!PATTERN.test(string) || isNaN(Date.parse(string))) throw new Error(`Invalid date string ${string}`);
    return string;
  },
  versionString(string, ctx) {
    const parts = string.split(".");
    if (parts.length > 4 || parts.some((p) => !/^(0|[1-9][0-9]{0,8})$/.test(p))) {
      ctx.warn("version must be a version string consisting of at most 4 integers of at most 9 digits without leading zeros, and separated with dots");
    }
    return string;
  },
};
// Formats that need Gecko services (CSP parser, ShortcutUtils) are accepted as is.
const UNCHECKED_FORMATS = new Set(["contentSecurityPolicy", "manifestShortcutKey", "manifestShortcutKeyOrEmpty"]);

class ValidationContext {
  constructor({ manifestVersion = 2, url = null } = {}) {
    this.manifestVersion = manifestVersion;
    this.url = url;
    this.warnings = [];
    this.path = [];
  }
  warn(message) {
    this.warnings.push(this.path.length ? `${this.path.join(".")}: ${message}` : message);
  }
  // Schemas.sys.mjs:782
  matchManifestVersion(entry) {
    const min = entry.min_manifest_version ?? MIN_MANIFEST_VERSION;
    const max = entry.max_manifest_version ?? MAX_MANIFEST_VERSION;
    return this.manifestVersion >= min && this.manifestVersion <= max;
  }
  withPath(p, fn) {
    this.path.push(p);
    try {
      return fn();
    } finally {
      this.path.pop();
    }
  }
  error(message) {
    return { error: this.path.length ? `Error processing ${this.path.join(".")}: ${message}` : message };
  }
}

class Namespace {
  constructor(name) {
    this.name = name;
    this.types = new Map();
    this.functions = new Map();
    this.events = new Map();
    this.properties = new Map();
    this.permissions = null;
    this.allowedContexts = [];
    this.defaultContexts = [];
    this.min_manifest_version = undefined;
    this.max_manifest_version = undefined;
    this.superName = null;
  }
}

class SchemaRoot {
  constructor(files) {
    this.namespaces = new Map();
    const extensions = [];
    for (const { url, json } of files) {
      for (const raw of json) {
        const ns = this.getOrCreate(raw.namespace);
        // Schemas.sys.mjs Namespace.addSchema: the last schema to set these wins.
        for (const prop of ["permissions", "allowedContexts", "defaultContexts", "min_manifest_version", "max_manifest_version"]) {
          if (raw[prop]) ns[prop] = raw[prop];
        }
        if (raw.$import) ns.superName = raw.$import;
        for (const t of raw.types || []) {
          if (t.$extend) extensions.push({ ns: raw.namespace, t });
          else if (!ns.types.has(t.id)) ns.types.set(t.id, { schema: structuredClone(t), ns: raw.namespace, src: url });
        }
        for (const f of raw.functions || []) {
          if (!ns.functions.has(f.name)) ns.functions.set(f.name, { schema: f, ns: raw.namespace, src: url });
        }
        for (const e of raw.events || []) {
          if (!ns.events.has(e.name)) ns.events.set(e.name, { schema: e, ns: raw.namespace, src: url });
        }
        for (const [k, v] of Object.entries(raw.properties || {})) {
          if (!ns.properties.has(k)) ns.properties.set(k, { schema: v, ns: raw.namespace, src: url });
        }
      }
    }
    // Schemas.sys.mjs ChoiceType.extend / ObjectType.extend
    for (const { ns, t } of extensions) {
      const base = this.namespaces.get(ns)?.types.get(t.$extend);
      if (!base) continue; // Gecko would ignore an $extend of an unloaded type too.
      if (base.schema.choices) {
        base.schema.choices.push(...structuredClone(t.choices || []));
      } else {
        base.schema.properties = base.schema.properties || {};
        for (const [k, v] of Object.entries(t.properties || {})) {
          if (k in base.schema.properties) throw new Error(`Attempt to extend ${ns}.${t.$extend} with conflicting property "${k}"`);
          base.schema.properties[k] = structuredClone(v);
        }
        if (t.patternProperties) {
          base.schema.patternProperties = { ...(base.schema.patternProperties || {}), ...structuredClone(t.patternProperties) };
        }
      }
    }
  }

  getOrCreate(name) {
    let ns = this.namespaces.get(name);
    if (!ns) this.namespaces.set(name, (ns = new Namespace(name)));
    return ns;
  }

  namespace(name) {
    return this.namespaces.get(name);
  }

  // Namespace.get falls back to the $import super namespace.
  lookup(nsName, kind, name) {
    let ns = this.namespaces.get(nsName);
    while (ns) {
      const hit = ns[kind].get(name);
      if (hit) return hit;
      ns = ns.superName ? this.namespaces.get(ns.superName) : null;
    }
    return undefined;
  }

  // Schemas.sys.mjs:1796 RefType.parseSchema
  resolveRef(ref, nsName) {
    let ns = nsName;
    let id = ref;
    if (ref.includes(".")) [, ns, id] = /^(.*)\.(.*?)$/.exec(ref);
    const hit = this.lookup(ns, "types", id);
    if (!hit) throw new Error(`Internal error: Type ${ref} not found (from ${nsName})`);
    return hit;
  }

  checkBaseType(s, baseType, nsName) {
    if ("choices" in s) return s.choices.some((c) => this.checkBaseType(c, baseType, nsName));
    if ("$ref" in s) {
      const t = this.resolveRef(s.$ref, nsName);
      return this.checkBaseType(t.schema, baseType, t.ns);
    }
    switch (s.type) {
      case "any":
        return true;
      case "number":
        return baseType == "number" || baseType == "integer";
      case "object":
        return baseType == "object";
      default:
        return baseType == s.type;
    }
  }

  checkDeprecated(s, ctx, value) {
    if (!s.deprecated) return;
    let message = "This property is deprecated";
    if (typeof s.deprecated == "string") {
      message = s.deprecated.replace(/\$\{value\}/g, () => JSON.stringify(value));
    }
    ctx.warn(message);
  }

  preprocess(s, value) {
    if (s.preprocess === "stringToLowerCase") return value.toLowerCase();
    return value; // "localize" is the identity outside Gecko.
  }

  /** @returns {{value:any}|{error:string}} */
  normalize(s, value, nsName, ctx) {
    if ("choices" in s) return this.normalizeChoices(s, value, nsName, ctx);
    if ("$ref" in s) {
      this.checkDeprecated(s, ctx, value);
      const t = this.resolveRef(s.$ref, nsName);
      return this.normalize(t.schema, value, t.ns, ctx);
    }
    const base = getValueBaseType(value);
    const expect = (type) => {
      if (this.checkBaseType({ type }, base, nsName)) return null;
      return ctx.error(`Expected ${type} instead of ${safeJson(value)}`);
    };
    let e;
    switch (s.type) {
      case "any":
        this.checkDeprecated(s, ctx, value);
        return { value };
      case "null":
        return expect("null") || { value };
      case "function":
        return expect("function") || { value };
      case "boolean":
        if ((e = expect("boolean"))) return e;
        if (s.enum && !s.enum.includes(value)) return ctx.error(`Invalid value ${safeJson(value)}`);
        this.checkDeprecated(s, ctx, value);
        return { value };
      case "number":
        if ((e = expect("number"))) return e;
        if (!Number.isFinite(value)) return ctx.error("NaN and infinity are not valid");
        this.checkDeprecated(s, ctx, value);
        return { value };
      case "integer": {
        if ((e = expect("integer"))) return e;
        this.checkDeprecated(s, ctx, value);
        if (!Number.isSafeInteger(value)) return ctx.error("Integer is out of range");
        const { minimum = -Infinity, maximum = Infinity } = s;
        if (value < minimum) return ctx.error(`Integer ${value} is too small (must be at least ${minimum})`);
        if (value > maximum) return ctx.error(`Integer ${value} is too big (must be at most ${maximum})`);
        return { value };
      }
      case "string":
        return this.normalizeString(s, value, nsName, ctx);
      case "array":
        return this.normalizeArray(s, value, nsName, ctx);
      case "object":
        return this.normalizeObject(s, value, nsName, ctx);
      default:
        throw new Error(`Unexpected type ${s.type} in ${JSON.stringify(s).slice(0, 200)}`);
    }
  }

  // Schemas.sys.mjs:1684 ChoiceType.normalize
  normalizeChoices(s, value, nsName, ctx) {
    this.checkDeprecated(s, ctx, value);
    const errors = [];
    for (const choice of s.choices) {
      if (!ctx.matchManifestVersion(choice)) continue;
      const saved = ctx.warnings.length;
      const r = this.normalize(choice, value, nsName, ctx);
      if (!r.error) return r;
      ctx.warnings.length = saved;
      errors.push(r.error);
    }
    if (errors.length <= 1) return { error: errors[0] || "No matching choice" };
    // Gecko lists every choice's requirement; a short form keeps failures readable.
    const leaves = [...new Set(errors.map((e) => e.replace(/^(Error processing [^:]*: )+/, "")))];
    const shown = leaves.length > 3 ? [...leaves.slice(0, 3), `and ${leaves.length - 3} more`] : leaves;
    return ctx.error(`Value ${safeJson(value)} matches none of the allowed choices (${shown.join("; ")})`);
  }

  // Schemas.sys.mjs:1835 StringType.normalize
  normalizeString(s, value, nsName, ctx) {
    if (typeof value !== "string") return ctx.error(`Expected string instead of ${safeJson(value)}`);
    this.checkDeprecated(s, ctx, value);
    value = this.preprocess(s, value);
    if (s.enum) {
      const allowed = s.enum.map((x) => (typeof x == "object" ? x.name : x));
      if (allowed.includes(value)) return { value };
      return ctx.error(`Invalid enumeration value ${safeJson(value)}`);
    }
    if (value.length < (s.minLength || 0)) return ctx.error(`String ${safeJson(value)} is too short (must be ${s.minLength})`);
    if (value.length > (s.maxLength || Infinity)) return ctx.error(`String ${safeJson(value)} is too long (must be ${s.maxLength})`);
    if (s.pattern && !parsePattern(s.pattern).test(value)) {
      return ctx.error(`String ${safeJson(value)} must match ${parsePattern(s.pattern)}`);
    }
    if (s.format) {
      if (UNCHECKED_FORMATS.has(s.format)) return { value };
      const fmt = FORMATS[s.format];
      if (!fmt) throw new Error(`Internal error: Invalid string format ${s.format}`);
      try {
        value = fmt(value, ctx);
      } catch (err) {
        return ctx.error(String(err));
      }
    }
    return { value };
  }

  // Schemas.sys.mjs:2525 ArrayType.normalize
  normalizeArray(s, value, nsName, ctx) {
    if (!Array.isArray(value)) return ctx.error(`Expected array instead of ${safeJson(value)}`);
    this.checkDeprecated(s, ctx, value);
    const onError = s.items.onError || null;
    const result = [];
    for (const [i, element] of value.entries()) {
      const r = ctx.withPath(String(i), () => this.normalize(s.items, element, nsName, ctx));
      if (r.error) {
        if (onError == "warn") ctx.warn(r.error);
        else if (onError != "ignore") return r;
        continue;
      }
      result.push(r.value);
    }
    if (result.length < (s.minItems || 0)) return ctx.error(`Array requires at least ${s.minItems} items; you have ${result.length}`);
    if (result.length > (s.maxItems || Infinity)) return ctx.error(`Array requires at most ${s.maxItems} items; you have ${result.length}`);
    return { value: result };
  }

  objectShape(s, nsName) {
    let properties = s.properties || {};
    let patternProperties = s.patternProperties || {};
    let additionalProperties = s.additionalProperties || null;
    if (s.$import) {
      const idx = s.$import.indexOf(".");
      const [ins, iid] = idx === -1 ? [nsName.split(".")[0], s.$import] : [s.$import.slice(0, idx), s.$import.slice(idx + 1)];
      const imported = this.lookup(ins, "types", iid).schema;
      properties = { ...(imported.properties || {}), ...properties };
      patternProperties = { ...(imported.patternProperties || {}), ...patternProperties };
      additionalProperties = imported.additionalProperties || additionalProperties;
    }
    if (additionalProperties === true) additionalProperties = { type: "any" };
    return { properties, patternProperties, additionalProperties };
  }

  // Schemas.sys.mjs:2005 ObjectType.normalize
  normalizeObject(s, value, nsName, ctx) {
    if (getValueBaseType(value) !== "object") return ctx.error(`Expected object instead of ${safeJson(value)}`);
    this.checkDeprecated(s, ctx, value);
    if (s.isInstanceOf) {
      const klass = Object.prototype.toString.call(value).slice(8, -1);
      if (klass !== s.isInstanceOf && !(s.isInstanceOf === "Element" && value.nodeType === 1)) {
        return ctx.error(`Object must be an instance of ${s.isInstanceOf}`);
      }
      return { value };
    }
    if (Object.prototype.toString.call(value) !== "[object Object]") {
      return ctx.error(`Expected a plain JavaScript object, got a ${Object.prototype.toString.call(value).slice(8, -1)}`);
    }
    const shape = this.objectShape(s, nsName);
    const properties = { ...value };
    const remaining = new Set(Object.keys(properties));
    const result = {};
    try {
      for (const prop of Object.keys(shape.properties)) {
        this.checkProperty(ctx, prop, shape.properties[prop], result, properties, remaining, nsName, !!shape.additionalProperties);
      }
      for (const prop of Object.keys(properties)) {
        for (const [pattern, type] of Object.entries(shape.patternProperties)) {
          if (parsePattern(pattern).test(prop)) {
            this.checkProperty(ctx, prop, type, result, properties, remaining, nsName, !!shape.additionalProperties);
          }
        }
      }
    } catch (e) {
      if (e && e.error) return e;
      throw e;
    }
    if (shape.additionalProperties) {
      for (const prop of remaining) {
        const r = ctx.withPath(prop, () => this.normalize(shape.additionalProperties, properties[prop], nsName, ctx));
        if (r.error) return r;
        result[prop] = r.value;
      }
    } else if (remaining.size) {
      if (remaining.size == 1) return ctx.error(`Unexpected property "${[...remaining]}"`);
      return ctx.error(`Unexpected properties: ${[...remaining].sort().join(", ")}`);
    }
    return { value: result };
  }

  // Schemas.sys.mjs:2200 ObjectType.checkProperty (throws {error} like Gecko).
  checkProperty(ctx, prop, propType, result, properties, remaining, nsName, hasAdditional) {
    const optional = propType.optional || false;
    const def = propType.default === undefined ? null : propType.default;
    let error = null;
    if (!ctx.matchManifestVersion(propType)) {
      if (prop in properties) {
        error = ctx.error(`Property "${prop}" is unsupported in Manifest Version ${ctx.manifestVersion}`);
        ctx.warn(error.error);
        if (hasAdditional) remaining.delete(prop);
      }
      return;
    } else if (propType.unsupported) {
      if (prop in properties) error = ctx.error(`Property "${prop}" is unsupported by Firefox`);
    } else if (prop in properties) {
      if (optional && (properties[prop] === null || properties[prop] === undefined)) {
        result[prop] = def;
      } else {
        const r = ctx.withPath(prop, () => this.normalize(propType, properties[prop], nsName, ctx));
        if (r.error) error = r;
        else {
          result[prop] = r.value;
          properties[prop] = r.value;
        }
      }
      remaining.delete(prop);
    } else if (!optional) {
      error = ctx.error(`Property "${prop}" is required`);
    } else if (optional !== "omit-key-if-missing") {
      result[prop] = def;
    }
    if (error) {
      if (propType.onError == "warn") ctx.warn(error.error);
      else if (propType.onError != "ignore") throw error;
      result[prop] = def;
    }
  }

  // Schemas.sys.mjs:2630-2668 FunctionType parameter parsing.
  functionParameters(fnSchema) {
    const isAsync = !!fnSchema.async;
    return (fnSchema.parameters || []).map((p) => {
      const isCallback = isAsync && p.name == fnSchema.async;
      return {
        name: p.name,
        schema: p,
        isCallback,
        optional: p.optional == null ? isCallback : p.optional,
        default: p.default == undefined ? null : p.default,
      };
    });
  }

  hasAsyncCallback(fnSchema) {
    const params = fnSchema.parameters || [];
    return !!fnSchema.async && params.length > 0 && params[params.length - 1].name == fnSchema.async;
  }

  // Schemas.sys.mjs:2898 CallEntry.checkParameters. Throws an Error with
  // Gecko's message text on failure; returns the normalized arguments.
  checkParameters(fnSchema, nsName, apiPath, args, ctx) {
    const parameters = this.functionParameters(fnSchema);
    if (fnSchema.allowAmbiguousOptionalArguments) {
      args = [...args];
      if (this.hasAsyncCallback(fnSchema) && typeof args[args.length - 1] != "function") args.push(null);
      return args;
    }
    const fixedArgs = [];
    const check = (pi, ai) => {
      if (pi == parameters.length) return ai == args.length;
      const parameter = parameters[pi];
      if (parameter.optional) {
        fixedArgs[pi] = parameter.default;
        if (check(pi + 1, ai)) return true;
      }
      if (ai == args.length) return false;
      const arg = args[ai];
      if (!this.checkBaseType(parameter.schema, getValueBaseType(arg), nsName)) {
        if (parameter.optional && (arg === null || arg === undefined)) fixedArgs[pi] = structuredClone(parameter.default);
        else return false;
      } else {
        fixedArgs[pi] = arg;
      }
      return check(pi + 1, ai + 1);
    };
    if (!check(0, 0)) throw new SchemaValidationError(`Incorrect argument types for ${apiPath}.`);
    return fixedArgs.map((arg, i) => {
      if (arg === null) return null;
      const parameter = parameters[i];
      const r = this.normalize(parameter.schema, arg, nsName, ctx);
      if (r.error) {
        throw new SchemaValidationError(`Type error for parameter ${parameter.name} (${r.error}) for ${apiPath}.`);
      }
      return r.value;
    });
  }

  /** Validate a value against a named type, e.g. ("manifest", "WebExtensionManifest"). */
  validateType(nsName, typeId, value, ctx) {
    const t = this.lookup(nsName, "types", typeId);
    if (!t) throw new Error(`No type ${nsName}.${typeId}`);
    return this.normalize(t.schema, value, t.ns, ctx);
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

module.exports = { SchemaRoot, ValidationContext, SchemaValidationError, getValueBaseType, parsePattern };
