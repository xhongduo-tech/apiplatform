#!/bin/sh
# Generate a trusted real-IP include without ever trusting arbitrary XFF.
set -eu

out=/tmp/real_ip.conf
: > "${out}"
raw="${TRUSTED_PROXY_CIDRS:-}"
[ -n "${raw}" ] || exit 0

case "${raw}" in
  *[!0-9A-Fa-f:.,/\ ]*)
    echo "invalid TRUSTED_PROXY_CIDRS; use a comma-separated IP/CIDR list" >&2
    exit 1
    ;;
esac

old_ifs=${IFS}
IFS=,
for cidr in ${raw}; do
  cidr="$(printf '%s' "${cidr}" | tr -d ' ')"
  [ -n "${cidr}" ] || { echo "empty trusted proxy CIDR" >&2; exit 1; }
  case "${cidr}" in
    0.0.0.0/0|::/0)
      echo "refusing to trust every address as a reverse proxy" >&2
      exit 1
      ;;
  esac
  printf 'set_real_ip_from %s;\n' "${cidr}" >> "${out}"
done
IFS=${old_ifs}
printf '%s\n' 'real_ip_header X-Forwarded-For;' 'real_ip_recursive on;' >> "${out}"
