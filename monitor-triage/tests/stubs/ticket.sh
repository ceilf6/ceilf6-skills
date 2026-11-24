#!/usr/bin/env bash
# internal-cli-ticket 机械层桩：只认 create，返回固定 story id/url。
echo "ticket-platform.sh $*" >> "$STUB_STATE/calls"
case "${1:-}" in
  create) echo '{"id":"7374348254","url":"<internal-url>"}' ;;
  *) echo '{"skipped":true}' ;;
esac
