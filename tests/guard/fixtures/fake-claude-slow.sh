#!/bin/sh
cat >/dev/null
sleep 5
printf %s '{"type":"result","subtype":"success","is_error":false,"result":"{\"verdict\":\"pass\",\"findings\":[]}"}'
