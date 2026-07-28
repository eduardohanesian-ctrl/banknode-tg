# Third-party notices

This project intentionally excludes `@silencelaboratories/dkls-wasm-ll-node`,
`@safeheron/mpc-wasm-sdk`, and every Go sidecar. They are not present in the
resolved dependency graph.

The threshold-ECDSA implementation is loaded from the MIT-licensed BitGoJS
package `@bitgo/sdk-core@38.4.0`. Its legacy GG18 mathematical primitives are
explicitly pinned to the last dependency line used here that contains no DKLS
non-commercial package: `@bitgo/sdk-lib-mpc@8.33.0`. The npm `overrides` entry
is security- and license-critical and must not be removed without review.

BitGoJS and `@bitgo/sdk-lib-mpc` are copyright BitGo, Inc. and contributors and
are distributed under the MIT License. Their full license texts are included
in their npm package directories after `npm ci`.

`ethers` is distributed under the MIT License. Other transitive notices are
available in the corresponding installed npm packages.
