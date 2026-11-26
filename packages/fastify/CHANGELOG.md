# @datatablex/fastify

## 0.2.0

### Minor Changes

- 2ff807a: Validates request bodies with zod 4 (`^4.6.7`) instead of zod 3. zod 3 has no fix for GHSA-mrhx-c7xc-m3w5: an oversized array that fails validation made zod collect one issue per element and could exhaust the server's memory. `sorting` and the export `keys` are now also cut by their length limit (`maxSortCount`, `maxSelectedKeys`) before zod sees them, as `filters` already was.

  A 400 `validation` response changes with zod 4. `message` uses the zod 4 wording for zod's own checks (for example `pagination: Invalid input: expected object, received undefined` instead of `pagination: Required`); the messages written by this package stay the same. The issues in `details` have the zod 4 shape: `too_big` and `too_small` carry `origin` instead of `type`, `invalid_type` no longer carries `received`, `invalid_enum_value` is now `invalid_value` with `values`, and `invalid_union` lists its branches in `errors`. `path` is unchanged. zod stays an internal dependency: an application that uses zod 3 itself is not affected.

### Patch Changes

- @datatablex/core@0.2.0

## 0.1.0

Initial release.
