"use strict";
// Builds `messenger`/`browser` objects from Thunderbird's real schemas, the way
// Gecko injects them (Schemas.sys.mjs InjectionEntry, :805-880, and
// ExtensionChild.sys.mjs shouldInject, :995-1030):
//   - an entry only exists if the manifest grants one of its "permissions"
//     ("manifest:<key>" means the manifest has that key);
//   - "unsupported" entries and entries outside the manifest version are absent;
//   - content scripts only get entries whose allowedContexts (or the
//     namespace's defaultContexts) include "content".
// Every function call is validated with the ported CallEntry.checkParameters
// before the fake implementation sees the normalized arguments; a schema error
// is thrown synchronously, as Gecko's stub does (Schemas.sys.mjs:3062-3068).
// Values the fake returns and event payloads it fires are validated too, so
// the fake cannot invent shapes Thunderbird would never produce.

const { ValidationContext, SchemaValidationError } = require("./schemas.js");

class FakeError extends Error {}

class ApiBuilder {
  /**
   * @param {object} opts
   * @param {import('./schemas.js').SchemaRoot} opts.root
   * @param {object} opts.manifest   parsed manifest.json
   * @param {object} opts.impl       map "ns.fn" -> (normalizedArgs, ctx) => value
   * @param {object} opts.world      receives .calls, .violations, .warnings, .missing, .listeners
   */
  constructor({ root, manifest, impl, world }) {
    this.root = root;
    this.manifest = manifest;
    this.manifestVersion = manifest.manifest_version;
    this.impl = impl;
    this.world = world;
  }

  hasPermission(perm) {
    if (perm.startsWith("manifest:")) return perm.slice("manifest:".length) in this.manifest;
    return (this.manifest.permissions || []).includes(perm);
  }

  matchManifestVersion(entry) {
    return new ValidationContext({ manifestVersion: this.manifestVersion }).matchManifestVersion(entry);
  }

  allowedIn(envType, allowedContexts) {
    if (envType === "content_child" && !allowedContexts.includes("content")) return false;
    if (envType !== "devtools_child" && allowedContexts.includes("devtools_only")) return false;
    if (envType !== "content_child" && allowedContexts.includes("content_only")) return false;
    return true;
  }

  /**
   * Why an entry would not be injected, or null if it would.
   * @param {object} entry   schema of the entry (function, event, property or namespace)
   * @param {string[]} parentDefaultContexts
   */
  whyAbsent(entry, parentDefaultContexts, envType) {
    if (entry.unsupported) return "unsupported";
    if (!this.matchManifestVersion(entry)) return `not in manifest version ${this.manifestVersion}`;
    const allowed = entry.allowedContexts?.length ? entry.allowedContexts : parentDefaultContexts;
    if (!this.allowedIn(envType, allowed)) return `not available in ${envType}`;
    if (entry.permissions && !entry.permissions.some((p) => this.hasPermission(p))) {
      return `needs permission ${entry.permissions.join(" or ")}`;
    }
    return null;
  }

  /**
   * @param {object} ctx  { name, envType: "addon_child"|"content_child", url, sender }
   */
  build(ctx) {
    const api = {};
    const names = [...this.root.namespaces.keys()].filter((n) => !n.includes("."));
    for (const name of names) this.defineNamespace(api, name, name, [], ctx);
    return api;
  }

  defineNamespace(target, prop, nsName, parentDefaults, ctx) {
    const ns = this.root.namespace(nsName);
    const nsEntry = {
      permissions: ns.permissions,
      allowedContexts: ns.allowedContexts,
      min_manifest_version: ns.min_manifest_version,
      max_manifest_version: ns.max_manifest_version,
    };
    let cache;
    Object.defineProperty(target, prop, {
      enumerable: true,
      configurable: true,
      get: () => {
        const why = this.whyAbsent(nsEntry, parentDefaults, ctx.envType);
        if (why) {
          this.world.missing.push({ api: nsName, why, context: ctx.name });
          return undefined;
        }
        if (!cache) cache = this.namespaceObject(nsName, ctx);
        return cache;
      },
    });
  }

  namespaceObject(nsName, ctx) {
    const obj = {};
    const collect = (kind) => {
      const out = new Map();
      for (let ns = this.root.namespace(nsName); ns; ns = ns.superName ? this.root.namespace(ns.superName) : null) {
        for (const [k, v] of ns[kind]) if (!out.has(k)) out.set(k, v);
      }
      return out;
    };
    const ns = this.root.namespace(nsName);
    const defaults = ns.defaultContexts || [];
    for (const [name, def] of collect("functions")) {
      this.defineMember(obj, name, def.schema, defaults, ctx, `${nsName}.${name}`, () => this.functionStub(def, `${nsName}.${name}`, ctx));
    }
    for (const [name, def] of collect("events")) {
      this.defineMember(obj, name, def.schema, defaults, ctx, `${nsName}.${name}`, () => this.eventObject(def, `${nsName}.${name}`, ctx));
    }
    for (const [name, def] of collect("properties")) {
      this.defineMember(obj, name, def.schema, defaults, ctx, `${nsName}.${name}`, () => this.propertyValue(def, `${nsName}.${name}`, ctx));
    }
    // Sub-namespaces such as messages.tags.
    for (const childName of this.root.namespaces.keys()) {
      if (childName.startsWith(nsName + ".") && !childName.slice(nsName.length + 1).includes(".")) {
        this.defineNamespace(obj, childName.slice(nsName.length + 1), childName, defaults, ctx);
      }
    }
    return obj;
  }

  defineMember(obj, name, schema, defaults, ctx, path, make) {
    let cache;
    Object.defineProperty(obj, name, {
      enumerable: true,
      configurable: true,
      get: () => {
        const why = this.whyAbsent(schema, defaults, ctx.envType);
        if (why) {
          this.world.missing.push({ api: path, why, context: ctx.name });
          return undefined;
        }
        if (cache === undefined) cache = make();
        return cache;
      },
    });
  }

  propertyValue(def, path, ctx) {
    const s = def.schema;
    if ("value" in s) return s.value;
    if (s.$ref) {
      const t = this.root.resolveRef(s.$ref, def.ns);
      if (t.schema.functions) {
        // A SubModuleProperty such as storage.local (Schemas.sys.mjs:2831-2866):
        // its functions and events are injected with the declaring namespace as
        // parent entry, and its extra "properties" are not injected at all.
        const obj = {};
        const defaults = this.root.namespace(def.ns).defaultContexts || [];
        for (const f of t.schema.functions) {
          this.defineMember(obj, f.name, f, defaults, ctx, `${path}.${f.name}`, () =>
            this.functionStub({ schema: f, ns: t.ns }, `${path}.${f.name}`, ctx)
          );
        }
        for (const e of t.schema.events || []) {
          this.defineMember(obj, e.name, e, defaults, ctx, `${path}.${e.name}`, () =>
            this.eventObject({ schema: e, ns: t.ns }, `${path}.${e.name}`, ctx)
          );
        }
        return obj;
      }
    }
    const getter = this.impl[path];
    return getter ? getter([], ctx) : undefined;
  }

  validationContext(ctx) {
    return new ValidationContext({ manifestVersion: this.manifestVersion, url: ctx.url });
  }

  recordWarnings(vctx, path, ctx) {
    for (const w of vctx.warnings) this.world.warnings.push({ api: path, warning: w, context: ctx.name });
  }

  functionStub(def, path, ctx) {
    const root = this.root;
    const fn = def.schema;
    const self = this;
    return function (...args) {
      const call = { api: path, args: cloneForLog(args), context: ctx.name };
      self.world.calls.push(call);
      const vctx = self.validationContext(ctx);
      if (fn.deprecated) root.checkDeprecated(fn, vctx);
      let actuals;
      try {
        actuals = root.checkParameters(fn, def.ns, path, args, vctx);
      } catch (e) {
        call.error = e.message;
        self.world.violations.push({ api: path, error: e.message, context: ctx.name });
        throw e;
      } finally {
        self.recordWarnings(vctx, path, ctx);
      }
      const implFn = self.impl[path];
      if (!implFn) {
        const err = new FakeError(`The fake Thunderbird does not implement ${path}; add it to tests/harness/thunderbird.js`);
        self.world.violations.push({ api: path, error: err.message, context: ctx.name });
        throw err;
      }
      if (fn.async) {
        if (root.hasAsyncCallback(fn)) {
          const cb = actuals.pop();
          if (cb) throw new FakeError(`${path}: callback style is not supported by the fake`);
        }
        const resultParam = root.hasAsyncCallback(fn) ? root.functionParameters(fn).at(-1).schema.parameters?.[0] : null;
        // Test hook: world.holds["ns.fn"] (FakeThunderbird.hold) keeps a call
        // unanswered until the test releases it, as a busy parent process
        // would. Only calls made while the hold is in place wait.
        const hold = self.world.holds?.[path];
        return (hold ? hold.promise : Promise.resolve())
          .then(() => {
            // Test hook: world.faults["ns.fn"] makes the implementation reject.
            // A function fault is asked per call, (ctx) => Error or nothing, so
            // a test can fail one page's calls and leave another's alone.
            const fault = self.world.faults?.[path];
            const error = typeof fault === "function" ? fault(ctx) : fault;
            if (error) throw error;
            return implFn(actuals, ctx);
          })
          .then((result) => {
            if (resultParam) self.checkFakeValue(resultParam, def.ns, result, `${path} result`);
            call.result = cloneForLog(result);
            return result;
          })
          .catch((e) => {
            call.rejected = e?.message;
            throw e;
          });
      }
      const result = implFn(actuals, ctx);
      if (fn.returns) self.checkFakeValue(fn.returns, def.ns, result, `${path} return value`);
      call.result = cloneForLog(result);
      return result;
    };
  }

  // A value produced by the fake must be one Thunderbird could produce.
  checkFakeValue(schema, nsName, value, what) {
    if (value === undefined && schema.optional) return;
    const vctx = new ValidationContext({ manifestVersion: this.manifestVersion });
    const r = this.root.normalize(schema, value, nsName, vctx);
    if (r.error) throw new FakeError(`FAKE BUG: ${what} does not match Thunderbird's schema: ${r.error}`);
  }

  eventObject(def, path, ctx) {
    const listeners = this.world.listeners;
    return {
      addListener: (fn, ...extra) => {
        if (typeof fn !== "function") throw new SchemaValidationError(`Incorrect argument types for ${path}.addListener.`);
        if (extra.length && !(def.schema.extraParameters || []).length) {
          throw new SchemaValidationError(`Incorrect argument types for ${path}.addListener.`);
        }
        listeners.push({ event: path, fn, ctx, schema: def.schema, ns: def.ns });
      },
      removeListener: (fn) => {
        const i = listeners.findIndex((l) => l.event === path && l.fn === fn && l.ctx === ctx);
        if (i >= 0) listeners.splice(i, 1);
      },
      hasListener: (fn) => listeners.some((l) => l.event === path && l.fn === fn && l.ctx === ctx),
    };
  }

  // Validates an event payload against the event's parameter list.
  checkEventArgs(schema, nsName, path, args) {
    const params = schema.parameters || [];
    params.forEach((p, i) => {
      if (p.type === "function") return; // sendResponse
      const v = args[i];
      if (v === undefined && p.optional) return;
      this.checkFakeValue(p, nsName, v, `${path} argument ${p.name}`);
    });
  }
}

function cloneForLog(v) {
  try {
    return structuredClone(v);
  } catch {
    return String(v);
  }
}

module.exports = { ApiBuilder, FakeError };
