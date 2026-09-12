/**
 * Shared schema conventions.
 *
 * Field names are camelCase and match the JSON the API already returned, so the
 * routes no longer need a column→key mapping layer.
 *
 * Calendar dates (`workDate`, `fromDate`, `dateOfJoining`…) stay `YYYY-MM-DD`
 * strings and clock times stay `HH:mm:ss` strings, exactly as the MySQL build
 * returned them. ISO date strings sort and range-compare lexicographically, so
 * `$gte` / `$lte` still work, and no timezone can shift a punch onto the wrong
 * day. Real `Date` is used only for true instants (createdAt, actionOn…).
 */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;

export const dateField = (extra = {}) => ({
  type: String,
  match: [DATE_RE, 'Expected YYYY-MM-DD'],
  ...extra,
});

export const timeField = (extra = {}) => ({
  type: String,
  match: [TIME_RE, 'Expected HH:mm:ss'],
  ...extra,
});

/** `_id` out, string `id` in — the shape every route responds with. */
export const jsonTransform = {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    ret.id = ret._id?.toString();
    delete ret._id;
    return ret;
  },
};

export const schemaOptions = (extra = {}) => ({
  timestamps: true,
  toJSON: jsonTransform,
  toObject: jsonTransform,
  ...extra,
});
