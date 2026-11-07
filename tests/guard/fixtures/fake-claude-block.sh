#!/bin/sh
cat >/dev/null
printf '%s' '{"type":"result","subtype":"success","is_error":false,"result":"{\"verdict\":\"block\",\"findings\":[{\"file\":\"a.md\",\"line\":3,\"reason\":\"identifies a client\"}]}"}'
