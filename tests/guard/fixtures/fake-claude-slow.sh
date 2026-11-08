#!/bin/sh
# Stand-in reviewer that is too slow. The reply is assembled from parts (no literal reply text).
cat >/dev/null
sleep 5
k=verd; v=pa
printf '{"type":"result","subtype":"success","is_error":false,"result":"{\\"%sict\\":\\"%sss\\",\\"findings\\":[]}"}' "$k" "$v"
