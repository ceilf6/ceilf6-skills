#!/usr/bin/env bash
# bytedcli-meego 机械层桩：只认 create，返回固定 story id/url。
echo "meego.sh $*" >> "$STUB_STATE/calls"
case "${1:-}" in
  create) echo '{"id":"7374348254","url":"https://meego.larkoffice.com/larksuite/story/detail/7374348254"}' ;;
  *) echo '{"skipped":true}' ;;
esac
