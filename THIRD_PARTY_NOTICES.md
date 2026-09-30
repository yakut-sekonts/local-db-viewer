# Third-party software notices

Local DB Viewer original source code is licensed under Apache-2.0. This does not
relicense the JDBC drivers, Java runtime, Electron, Chromium or npm dependencies.
Their original copyright notices, licenses and exceptions remain applicable.

## Included notices

The installed application includes an offline viewer at **Local DB Viewer →
Лицензии**. Its `resources/legal` directory contains:

- `LICENSE` and `NOTICE` for Local DB Viewer;
- `licenses/jdbc-manifest.json` and the original texts for the pinned JDBC JARs
  and their embedded libraries, including dependencies shaded by upstream;
- `licenses/npm-manifest.json` and original notices for production npm packages;
- Electron's `LICENSE` and `LICENSES.chromium.html` from the actual build;
- `distribution-manifest.json`, recording the hashes of the supplied documents.

The complete Temurin `NOTICE` and `legal` directory remain in `resources/jre`.
On macOS, `resources` is `Local DB Viewer.app/Contents/Resources`; on Windows it
is the `resources` directory next to the executable. The build verifies that
packaging preserves these files, including Java legal symlinks and their targets.

Notices copied from upstream are not project release notes and are kept in their
original language and wording. Multiple licenses in a notice may apply to
different embedded parts; a summary identifier does not replace the full text.
The npm inventory also retains notices for optional production dependencies that
are used on only one platform. Catalog drivers downloaded later and user-supplied
JARs are separate distributions and retain their own upstream terms.

## Sources and rebuilding

Each new release includes `Local-DB-Viewer-VERSION-third-party-sources.zip` next to
the installers, covered by `SHA256SUMS.txt`. It contains:

- the exact tagged Local DB Viewer source tree and build scripts;
- the original Temurin/OpenJDK source archive and upstream build metadata;
- complete upstream MySQL Connector/J and MariaDB Connector/J source trees,
  including their build definitions;
- the published Trino JDBC source JAR, including relocated dependency sources
  (notably Jakarta Annotations), and the original Trino build POMs;
- `source-lock.json`, original download URLs, sizes and SHA256 hashes.

These components are distributed as unmodified upstream binaries. Trino and
ClickHouse shading was performed by their upstream publishers, not by Local DB
Viewer. The locked binary URLs and hashes are in `build/runtime-lock.json`.
The source archive is provided separately to avoid adding it to every installer.
For earlier releases, the exact upstream source URLs remain recorded in the
source lock. Do not substitute sources for a different binary version.

Source repository: https://github.com/yakut-sekonts/local-db-viewer

MySQL Connector/J is distributed under its GPLv2 terms and Universal FOSS
Exception; MariaDB Connector/J under LGPL-2.1-or-later; Temurin under GPLv2 with
the applicable Classpath and other exceptions. See the original texts, rather
than interpreting Apache-2.0 as replacing those terms. Jakarta Annotations
includes EPL-2.0 and secondary-license provisions in its LICENSE/NOTICE.

The source trees include their upstream build instructions. To rebuild Local DB
Viewer, follow README.md: use Node.js 24, Python 3.12+ and JDK 25, run `npm ci`,
prepare the pinned runtime, and run the platform package command. The Java bridge
is compiled from `jdbc/` by `scripts/build-jdbc.mjs`. Electron source and its
dependency/build references for the exact Electron version are available at
https://github.com/electron/electron/releases and
https://github.com/electron/electron/blob/main/docs/development/build-instructions-gn.md.
The installed Electron version is recorded in `distribution-manifest.json`;
production npm source tarball URLs and integrity values are in the npm manifest.

## Replacing a driver

JDBC drivers are loaded dynamically in the Java bridge. In **JDBC-драйверы**,
import your replacement JARs, choose that version and reconnect. The application
does not require those JARs to be signed by Local DB Viewer. This supports using
and debugging modified LGPL libraries. The Apache-2.0 project license does not
impose an additional restriction on reverse engineering for debugging such
modifications. Replacement JARs must implement the expected JDBC interface and
are code executed with the user's permissions.

## Maintaining this inventory

`node scripts/build-licenses.mjs --check` validates the reviewed manifest against
the current runtime and npm locks. Changing a version or hash requires reviewing
the corresponding licenses, notices, embedded dependencies and source archive.
For npm updates, run `python3 scripts/update-npm-licenses.py` after `npm ci`, review
the generated diff and preserve any new upstream attribution requirements. For
JDBC, inspect both the JAR and its original upstream build: a dependency-reduced
Maven POM can omit libraries actually embedded by shading.

Automated checks verify recorded coverage, integrity and inclusion; they do not
determine the legal compatibility of arbitrary new dependencies or certify a
distribution's compliance with every license obligation.
