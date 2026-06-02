'use strict';

/**
 * Body schema validator middleware factory.
 *
 * Rules per field:
 *   required   – field must be present and non-empty
 *   type       – 'string' | 'number' | 'boolean'
 *   min/max    – numeric range (inclusive)
 *   minLen/maxLen – string length bounds
 *   pattern    – RegExp (strings only)
 *   patternMsg – custom message for pattern failure
 *   enum       – array of allowed values
 *   trim       – auto-trim string in place (mutates req.body)
 *   integer    – coerce + validate as integer (mutates req.body)
 */
function body(schema) {
  return (req, _res, next, _abort) => {
    // Make sure body exists
    if (!req.body || typeof req.body !== 'object') req.body = {};

    const errors = [];

    for (const [key, r] of Object.entries(schema)) {
      let val = req.body[key];
      const missing = val === undefined || val === null || val === '';

      if (r.required && missing) {
        errors.push(`${key} is required`);
        continue;
      }
      if (missing) continue;

      // Auto-trim strings
      if (r.trim && typeof val === 'string') {
        req.body[key] = val = val.trim();
      }

      // Coerce to integer
      if (r.integer) {
        const n = parseInt(val, 10);
        if (!Number.isFinite(n)) { errors.push(`${key} must be an integer`); continue; }
        req.body[key] = val = n;
      }

      // Type check
      if (r.type && typeof val !== r.type) {
        errors.push(`${key} must be a ${r.type}`);
        continue;
      }

      if (typeof val === 'number') {
        if (!Number.isFinite(val)) { errors.push(`${key} must be a finite number`); continue; }
        if (r.min !== undefined && val < r.min) errors.push(`${key} must be at least ${r.min}`);
        if (r.max !== undefined && val > r.max) errors.push(`${key} must be at most ${r.max}`);
      }

      if (typeof val === 'string') {
        if (r.minLen !== undefined && val.length < r.minLen)
          errors.push(`${key} must be at least ${r.minLen} characters`);
        if (r.maxLen !== undefined && val.length > r.maxLen)
          errors.push(`${key} must be at most ${r.maxLen} characters`);
        if (r.pattern && !r.pattern.test(val))
          errors.push(r.patternMsg || `${key} format is invalid`);
      }

      if (r.enum && !r.enum.includes(val)) {
        errors.push(`${key} must be one of: ${r.enum.join(', ')}`);
      }
    }

    if (errors.length) {
      // Call next with an error object so the global error handler picks it up,
      // OR respond directly — we respond directly so callers get a clean 400.
      return _res.status(400).json({ error: errors[0], errors });
    }
    next();
  };
}

/**
 * URL params coercion: parse named params as positive integers.
 * Usage: validate.params(['id'])
 */
function params(fields) {
  return (req, res, next) => {
    for (const key of fields) {
      const n = parseInt(req.params[key], 10);
      if (!Number.isFinite(n) || n <= 0)
        return res.status(400).json({ error: `${key} must be a positive integer` });
      req.params[key] = n;
    }
    next();
  };
}

module.exports = { body, params };
