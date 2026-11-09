#!/bin/sh
set -eu
image=$1
out=$2
component=${4:?image component required}
mkdir -p "$out"
phase='image inventory'
assessment_done=0
archive_dir=
finish() {
  result=$?
  if [ "$assessment_done" != 1 ]; then
    node scripts/security-findings.js --unavailable "$out" "$component" "$phase failed; retry or review this assessment" || true
    [ "$result" != 0 ] || result=1
  fi
  [ -z "$archive_dir" ] || rm -rf "$archive_dir"
  exit "$result"
}
trap finish EXIT
rm -f "$out/assessment.json" "$out/vulnerabilities.json" "$out/image-vulnerabilities.json"
printf '%s\n' "$image" > "$out/image-reference.txt"
case "$image" in
  *@sha256:*) ;;
  *) docker image inspect --format '{{.Id}}' "$image" > "$out/image-reference.txt" ;;
esac
# The release pipeline passes BuildKit's attached SPDX SBOM, covering OS and
# global tools as well as lockfile packages. Local builds may pass a Syft SBOM.
sbom=$3
test -s "$sbom"

# BASELINE_IMAGE (the live image of this component, by digest) makes the gate
# block only what this image introduces: a finding on a package the live image
# already ships at the same version is reported, not failed.
#
# An image with the live image's own digest is the live image: nothing in it
# can be introduced, so it is not pulled for the runtime probes or saved for
# the full-image scan. Those two hold the image twice on the runner's disk,
# and the worker image filled it (31 Oct 2026, the release for #6072, whose
# worker image was the live one, reused). Its SBOM is the live SBOM, so the
# SBOM scan still runs for the record, against itself.
digest_of() {
  case "$1" in *@sha256:*) printf '%s\n' "${1##*@}" ;; *) printf '\n' ;; esac
}
live=
if [ -n "${BASELINE_IMAGE:-}" ] && [ -n "$(digest_of "$image")" ] \
  && [ "$(digest_of "$image")" = "$(digest_of "$BASELINE_IMAGE")" ]; then
  live=1
fi

if [ -z "$live" ]; then
  phase='runtime probes'
  # No app command, network or production credentials are used by these probes.
  docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint node "$image" < scripts/check-node-runtime.js > "$out/runtime.json"
  docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint node "$image" < scripts/image-npm-inventory.js > "$out/npm-inventory.json"
fi
# Download the public database in a container that sees no project files.
# Scanners that receive the SBOM or image archive have networking disabled.
phase='vulnerability database download'
docker run --rm -v social-security-trivy-db:/root/.cache/trivy \
  aquasec/trivy:0.76.1 image --download-db-only
# Keep complete reports, including unfixed and lower-severity findings.
phase='SBOM scan'
docker run --rm --network none -v "$(cd "$(dirname "$sbom")" && pwd):/input:ro" \
  -v "$(cd "$out" && pwd):/output" -v social-security-trivy-db:/root/.cache/trivy \
  aquasec/trivy:0.76.1 sbom --skip-db-update --offline-scan --cache-backend memory \
  --scanners vuln --format json --output /output/vulnerabilities.json \
  "/input/$(basename "$sbom")"
test -s "$out/vulnerabilities.json"
if [ -z "$live" ]; then
  phase='full-image scan'
  # A third-party SPDX document can lose distro metadata. Scan the actual
  # image too, independently of the complete global-npm SBOM inventory.
  archive_dir=$(mktemp -d)
  docker image save -o "$archive_dir/image.tar" "$image"
  docker run --rm --network none -v "$archive_dir/image.tar:/image.tar:ro" \
    -v "$(cd "$out" && pwd):/output" -v social-security-trivy-db:/root/.cache/trivy \
    aquasec/trivy:0.76.1 image --skip-db-update --offline-scan --cache-backend memory \
    --input /image.tar --scanners vuln --format json --output /output/image-vulnerabilities.json
  test -s "$out/image-vulnerabilities.json"
  rm -rf "$archive_dir"
  archive_dir=
fi

baseline=
baseline_name=
phase='scan validation'
potential=$(node scripts/security-findings.js --potential "$out" "$component")
if [ "${SECURITY_AUDIT_ONLY:-}" = 1 ]; then
  : # A full audit records findings independently of a release decision.
elif [ "$potential" = 0 ]; then
  : # A clean candidate needs no second image build or baseline lookup.
elif [ -n "${SECURITY_BASELINE_REVISION:-}" ]; then
  phase='PR-base inventory generation'
  baseline="$out/baseline-sbom.spdx.json"
  node scripts/security-image-baseline.js "$component" "$SECURITY_BASELINE_REVISION" "$baseline"
  baseline_name="PR base $SECURITY_BASELINE_REVISION"
elif [ -n "$live" ]; then
  printf '%s\n' "$BASELINE_IMAGE" > "$out/baseline-image-reference.txt"
  baseline="$sbom"
  baseline_name='the recorded release image'
  note="Same digest as the live image ($(digest_of "$image")): the runtime probes and the full-image scan are skipped, since nothing in it can be introduced by this release. The SBOM scan ran for the record."
  printf '%s\n' "$note" > "$out/live-image.txt"
  echo "::notice title=$component image is the live image::$note"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '### %s image\n\n%s\n\n' "$component" "$note" >> "$GITHUB_STEP_SUMMARY"
  fi
elif [ -n "${BASELINE_IMAGE:-}" ]; then
  # Reading the live image's SBOM attestation pulls no layers. Unreadable,
  # a failed comparison is unavailable, not a newly introduced vulnerability.
  phase='release baseline retrieval'
  if docker buildx imagetools inspect "$BASELINE_IMAGE" --format '{{json .SBOM}}' > "$out/baseline-buildkit-sbom.json" \
    && node scripts/image-spdx.js "$out/baseline-buildkit-sbom.json" "$out/baseline-sbom.spdx.json"; then
    printf '%s\n' "$BASELINE_IMAGE" > "$out/baseline-image-reference.txt"
    baseline="$out/baseline-sbom.spdx.json"
    baseline_name='the recorded release image'
  else
    exit 2
  fi
else
  phase='baseline unavailable'
  exit 2
fi
phase='assessment'
status=0
node scripts/security-findings.js --assess "$out" "$component" "$baseline" "$baseline_name" || status=$?
if [ -s "$out/assessment.json" ]; then assessment_done=1; fi
exit "$status"
