# Third-party notices

This repository's source code is licensed under the [MIT License](LICENSE).
It depends on third-party packages and container images that remain subject to
their own copyright notices and license terms. The MIT license for this
repository does not replace those terms.

The authoritative dependency inventories are:

- `nextjs/package-lock.json`
- `dbt-runner/uv.lock`
- base images and tool images pinned in Dockerfiles and GitHub workflows

The release audit found predominantly MIT, ISC, BSD, Apache-2.0, MPL-2.0,
BlueOak, PSF, and similarly permissive dependencies. Items requiring explicit
distribution review include:

- `@img/sharp-libvips-*` / libvips (LGPL);
- `text-unidecode` (dual Artistic/GPL; the distribution must comply with a
  selected applicable license);
- packages whose metadata reports `UNKNOWN`, which must be checked against the
  license file shipped in the artifact.

Before each release, regenerate and archive the complete inventory:

```bash
cd nextjs
npx --yes license-checker-rseidelsohn --production --summary

cd ../dbt-runner
uv sync --frozen
uvx pip-licenses --python .venv/bin/python --format=markdown --summary
```

The release publisher is responsible for including required license texts and
source/relocation notices in distributed images and archives. This file is an
engineering inventory, not legal advice.
