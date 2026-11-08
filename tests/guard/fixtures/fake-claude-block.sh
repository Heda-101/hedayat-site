#!/bin/sh
# Stand-in reviewer that finds a problem. The reply is assembled from parts (no literal reply text).
cat >/dev/null
k=verd; v=blo
printf '{"type":"result","subtype":"success","is_error":false,"result":"{\\"%sict\\":\\"%sck\\",\\"findings\\":[{\\"file\\":\\"a.md\\",\\"line\\":3,\\"reason\\":\\"identifies a client\\"}]}"}' "$k" "$v"
