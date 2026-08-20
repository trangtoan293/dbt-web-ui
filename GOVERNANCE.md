# Governance

The project currently uses a maintainer-led model while the contributor
community is small.

## Roles

- **Contributors** submit issues, discussions, reviews, documentation, and code
  under the DCO process in [CONTRIBUTING.md](CONTRIBUTING.md).
- **Maintainers** triage work, review and merge pull requests, manage releases,
  and enforce the Code of Conduct and security policy.
- **Code owners** are listed in [`.github/CODEOWNERS`](.github/CODEOWNERS).

## Decisions

Routine changes are decided through pull-request review. Maintainers should
record security-boundary, compatibility, data-model, and irreversible
architecture decisions in `docs/adr/`.

Material changes to licensing, governance, telemetry, contributor terms, the
public brand, or the security support policy require a public proposal and
explicit maintainer approval. Legal/IP and embargoed vulnerability decisions
may be discussed privately, but their non-sensitive outcome should be
documented.

## Becoming a maintainer

A contributor may be invited after a sustained record of technically sound
contributions, respectful review, security awareness, and reliable project
stewardship. Existing maintainers decide by consensus and update CODEOWNERS in
the same pull request.

## Inactivity and succession

Maintainers may step down at any time. If the project has no responsive
maintainer for 90 days, active contributors should open a governance issue to
identify a successor or clearly mark the project unmaintained.
