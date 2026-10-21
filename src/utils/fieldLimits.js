// Column length limits — keep in sync with the database schema (library4.sql).
// The live MySQL server runs in non-strict mode, so values longer than these
// limits would be silently truncated instead of rejected. We validate here so
// users get a clear error message instead of corrupted data.

const FIELD_LIMITS = {
  user_id: { max: 11, label: 'User ID' },
  id_no: { max: 11, label: 'ID No' },
  username: { max: 30, label: 'Username / Full name' },
  designation: { max: 50, label: 'Designation' },
  access_right: { max: 50, label: 'Access right' },
  firstname: { max: 15, label: 'First name' },
  middle_name: { max: 15, label: 'Middle name' },
  lastname: { max: 15, label: 'Last name' },
  mobile_phone: { max: 11, label: 'Mobile phone' },
  phone: { max: 11, label: 'Phone' },
  email: { max: 30, label: 'Email' },
  address: { max: 100, label: 'Address' },
};

/**
 * Returns an error message for the first field that exceeds its column limit,
 * or null if every provided field fits.
 * @param {Record<string, unknown>} values
 */
function checkFieldLengths(values) {
  for (const [field, value] of Object.entries(values)) {
    const rule = FIELD_LIMITS[field];
    if (!rule || value === undefined || value === null) continue;
    const length = String(value).trim().length;
    if (length > rule.max) {
      return `${rule.label} must be at most ${rule.max} characters (got ${length}).`;
    }
  }
  return null;
}

module.exports = { FIELD_LIMITS, checkFieldLengths };
