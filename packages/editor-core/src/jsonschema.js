// A small, dependency-free JSON Schema validator (a 2020-12 subset), enough for the edit plan v2 schema.
// Pure: no DOM, no I/O, never mutates the schema or the value.
//
// Supported keywords
//   type (string or array; 'integer' = whole numbers; 'number' excludes NaN/Infinity), enum, const,
//   required, properties, additionalProperties (boolean or schema), items, minItems, maxItems,
//   minimum, maximum, exclusiveMinimum, exclusiveMaximum, minLength, maxLength, pattern,
//   anyOf, oneOf, allOf, $ref to local JSON pointers ("#", "#/$defs/x", "#/properties/layout"), $defs,
//   and boolean schemas (true / false).
// Annotations (title, description, default, examples, $comment, $id, $schema, x-*) are ignored.
//
// validate(schema, value) -> { valid, errors: [{ path, message, keyword }] }
//   path is a JSON pointer into the VALUE ('' = root, '/words/3/start'). A missing required property is
//   reported at the property's own path ('/sources/screen' + 'is required'). keyword names the failing rule.

const MAX_DEPTH = 512;
const SHAPE_KEYWORDS = new Set(['type', 'enum', 'const', 'false']);
const patterns = new Map(); // compiled `pattern` regexes, shared across calls

function regex(source) {
  let re = patterns.get(source);
  if (!re) { re = new RegExp(source, 'u'); patterns.set(source, re); }
  return re;
}

export function validate(schema, value) {
  const errors = [];
  check(schema, value, '', { root: schema, refs: new Map(), depth: 0 }, errors);
  return { valid: errors.length === 0, errors };
}

/** Escape one JSON pointer segment. */
export function pointerSegment(key) {
  return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Resolve a local "#/..." reference against the root schema. Throws on anything it can't resolve. */
export function resolveRef(root, ref) {
  if (typeof ref !== 'string' || ref[0] !== '#') throw new Error(`Unsupported $ref ${JSON.stringify(ref)} (only local "#/..." pointers)`);
  if (ref === '#' || ref === '#/') return root;
  if (ref[1] !== '/') throw new Error(`Unsupported $ref ${JSON.stringify(ref)} (anchors are not supported)`);
  let node = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !(key in node)) throw new Error(`Unresolvable $ref ${ref}`);
    node = node[key];
  }
  return node;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isType(v, t) {
  switch (t) {
    case 'null': return v === null;
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    default: throw new Error(`Unknown type ${JSON.stringify(t)} in schema`);
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (a && typeof a === 'object') {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

const show = (v) => JSON.stringify(v);

function check(schema, value, path, ctx, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) { errors.push({ path, message: 'is not allowed', keyword: 'false' }); return; }
  if (schema === null || typeof schema !== 'object') throw new Error(`Invalid schema at ${path || '/'}: ${show(schema)}`);
  if (ctx.depth > MAX_DEPTH) throw new Error(`Schema recursion too deep at ${path || '/'} (cyclic $ref?)`);

  if (schema.$ref !== undefined) {
    let target = ctx.refs.get(schema.$ref);
    if (target === undefined) { target = resolveRef(ctx.root, schema.$ref); ctx.refs.set(schema.$ref, target); }
    ctx.depth++;
    check(target, value, path, ctx, errors);
    ctx.depth--;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(value, t))) errors.push({ path, message: `must be ${types.join(' or ')} (got ${typeOf(value)})`, keyword: 'type' });
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push({ path, message: `must be one of ${schema.enum.map(show).join(', ')}`, keyword: 'enum' });
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) errors.push({ path, message: `must equal ${show(schema.const)}`, keyword: 'const' });

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && !(value >= schema.minimum)) errors.push({ path, message: `must be >= ${schema.minimum}`, keyword: 'minimum' });
    if (schema.maximum !== undefined && !(value <= schema.maximum)) errors.push({ path, message: `must be <= ${schema.maximum}`, keyword: 'maximum' });
    if (schema.exclusiveMinimum !== undefined && !(value > schema.exclusiveMinimum)) errors.push({ path, message: `must be > ${schema.exclusiveMinimum}`, keyword: 'exclusiveMinimum' });
    if (schema.exclusiveMaximum !== undefined && !(value < schema.exclusiveMaximum)) errors.push({ path, message: `must be < ${schema.exclusiveMaximum}`, keyword: 'exclusiveMaximum' });
  }

  if (typeof value === 'string') {
    const len = [...value].length;
    if (schema.minLength !== undefined && len < schema.minLength) errors.push({ path, message: `must have at least ${schema.minLength} characters`, keyword: 'minLength' });
    if (schema.maxLength !== undefined && len > schema.maxLength) errors.push({ path, message: `must have at most ${schema.maxLength} characters`, keyword: 'maxLength' });
    if (schema.pattern !== undefined && !regex(schema.pattern).test(value)) errors.push({ path, message: `must match pattern ${schema.pattern}`, keyword: 'pattern' });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, message: `must have at least ${schema.minItems} items`, keyword: 'minItems' });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, message: `must have at most ${schema.maxItems} items`, keyword: 'maxItems' });
    if (schema.items !== undefined) {
      ctx.depth++;
      value.forEach((item, i) => check(schema.items, item, `${path}/${i}`, ctx, errors));
      ctx.depth--;
    }
  }

  if (isType(value, 'object')) {
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) errors.push({ path: `${path}/${pointerSegment(key)}`, message: 'is required', keyword: 'required' });
    }
    ctx.depth++;
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) continue; // JSON has no undefined: treat as absent
      const p = `${path}/${pointerSegment(key)}`;
      if (Object.prototype.hasOwnProperty.call(props, key)) check(props[key], v, p, ctx, errors);
      else if (schema.additionalProperties === false) errors.push({ path: p, message: 'is not allowed', keyword: 'additionalProperties' });
      else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) check(schema.additionalProperties, v, p, ctx, errors);
    }
    ctx.depth--;
  }

  if (schema.allOf) for (const sub of schema.allOf) { ctx.depth++; check(sub, value, path, ctx, errors); ctx.depth--; }
  if (schema.anyOf) {
    const runs = branches(schema.anyOf, value, path, ctx);
    if (!runs.some((r) => r.length === 0)) errors.push(...explain(runs, path, 'anyOf'));
  }
  if (schema.oneOf) {
    const runs = branches(schema.oneOf, value, path, ctx);
    const matched = runs.filter((r) => r.length === 0).length;
    if (matched === 0) errors.push(...explain(runs, path, 'oneOf'));
    else if (matched > 1) errors.push({ path, message: `must match exactly one schema in oneOf (matched ${matched})`, keyword: 'oneOf' });
  }
}

function branches(list, value, path, ctx) {
  return list.map((sub) => {
    const errs = [];
    ctx.depth++;
    check(sub, value, path, ctx, errs);
    ctx.depth--;
    return errs;
  });
}

// When no branch matches, report the errors of the one branch whose shape fits the value (e.g. the object
// branch of `anyOf: [source, null]`), so nested paths stay useful. Otherwise give one summary error.
function explain(runs, path, keyword) {
  const shapeFits = runs.filter((errs) => !errs.some((e) => e.path === path && SHAPE_KEYWORDS.has(e.keyword)));
  if (shapeFits.length === 1) return shapeFits[0];
  return [{ path, message: `must match ${keyword === 'oneOf' ? 'exactly one' : 'at least one'} schema in ${keyword}`, keyword }];
}
